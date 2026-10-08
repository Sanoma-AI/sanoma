import { readFileSync } from "node:fs";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { startTestWorker, testDatabaseUrl } from "@sanoma/testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  allowAll,
  defineWorkflow,
  memoryLedger,
  resolveConfig,
  RUNTIME_VERSION,
  SanomaClient,
  type SanomaConfig,
  startWorker,
} from "../src/index.ts";
import announce from "./fixtures/announce.ts";
import { inSeconds, marketingFakes, waitFor } from "./harness.ts";

const vendors = marketingFakes();
// Two builds of one workflow. Only the body's source is hashed, not what it closes over.
const shout = {
  trigger: "manual",
  input: z.object({ text: z.string() }),
  uses: [bluesky.post.create],
} as const;
const loudly = defineWorkflow({
  name: "shout",
  ...shout,
  run: async (ctx, { text }) => ctx.bluesky.post.create({ text: text.toUpperCase() }),
});
const excitedly = defineWorkflow({
  name: "shout",
  ...shout,
  run: async (ctx, { text }) => ctx.bluesky.post.create({ text: `${text}!` }),
});
/** Ends at once, so a test can tell a run that ran from one left queued. */
const quick = defineWorkflow({
  name: "quick",
  trigger: "manual",
  input: z.object({}),
  uses: [],
  run: async () => "done",
});

const base: SanomaConfig = {
  workflows: [announce],
  connectors: [ghost, resend, bluesky],
  drivers: vendors.drivers,
  policy: allowAll,
  ledger: memoryLedger(),
  appName: "acme",
};
const versionOf = (config: Partial<SanomaConfig>) => resolveConfig({ ...base, ...config }).version;
/** DBOS's own override, read when the config is resolved; prefixed with the app name like the hash. */
const named = (version: string) => {
  process.env.DBOS__APPVERSION = version;
};
afterEach(() => {
  delete process.env.DBOS__APPVERSION;
});

describe("the application version", () => {
  it("is the package's version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(RUNTIME_VERSION).toBe(pkg.version);
  });

  it("is a hash of the workflows, prefixed with the app name", () => {
    expect(versionOf({})).toMatch(/^acme@[0-9a-f]{64}$/);
    expect(versionOf({})).toBe(versionOf({}));
    expect(versionOf({ appName: "other" })).toMatch(/^other@/);
    expect(versionOf({ appName: "other" }).slice("other@".length)).not.toBe(versionOf({}).slice("acme@".length));
  });

  it("changes when a workflow's body changes, and not when a driver or the policy does", () => {
    // One workflow name per process, so these definitions are only resolved, never registered.
    const loud = versionOf({ workflows: [loudly] });
    expect(versionOf({ workflows: [excitedly] })).not.toBe(loud);
    const loudlyAgain = defineWorkflow({
      name: "shout",
      ...shout,
      run: async (ctx, { text }) => ctx.bluesky.post.create({ text: text.toUpperCase() }),
    });
    expect(versionOf({ workflows: [loudlyAgain] })).toBe(loud);

    const drivers = marketingFakes().drivers.map((d) => ({ ...d, ops: { ...d.ops } }));
    expect(versionOf({ drivers })).toBe(versionOf({}));
    expect(versionOf({ policy: () => ({ kind: "deny", reason: "no" }) })).toBe(versionOf({}));
    expect(versionOf({ workflows: [] })).not.toBe(versionOf({}));
  });

  it("changes when a workflow's input schema or the operations it uses change, with the same body", () => {
    const loud = versionOf({ workflows: [loudly] });
    // The same function, so the same source: only the schema or the uses differ.
    const stricter = defineWorkflow({
      ...shout,
      name: "shout",
      input: z.object({ text: z.string().min(1) }),
      run: loudly.run,
    });
    expect(versionOf({ workflows: [stricter] })).not.toBe(loud);
    const wider = defineWorkflow({
      ...shout,
      name: "shout",
      uses: [bluesky.post.create, ghost.post.create],
      run: loudly.run as never,
    });
    expect(versionOf({ workflows: [wider] })).not.toBe(loud);
  });

  it("is DBOS__APPVERSION when that is set, still prefixed with the app name", () => {
    named("abc123");
    expect(versionOf({})).toBe("acme@abc123");
    named(" ");
    expect(versionOf({})).toMatch(/^acme@[0-9a-f]{64}$/);
  });
});

describe("workers on one database", () => {
  // Needs Postgres: `pnpm db:up`.
  const databaseUrl = testDatabaseUrl("version");
  const config = (appName: string, extra: Partial<SanomaConfig> = {}): SanomaConfig => ({
    ...base,
    appName,
    databaseUrl,
    ledger: memoryLedger(),
    ...extra,
  });
  const leftPending: string[] = [];

  afterAll(async () => {
    if (!leftPending.length) return;
    const raw = await DBOSClient.create({ systemDatabaseUrl: databaseUrl });
    await raw.cancelWorkflows(leftPending);
    await raw.destroy();
  });

  // The suites in announce.test.ts already share a database with computed versions.
  it("start two apps one after the other without a queue or version conflict, each running its own runs", async () => {
    for (const appName of ["version-a", "version-b"]) {
      // The same version name for both: it is prefixed with the app name.
      named("1");
      const cfg = config(appName);
      const worker = await startWorker(cfg);
      const client = await SanomaClient.connect(cfg);
      try {
        const runId = await client.start(
          announce,
          { title: appName, body: "<p>x</p>", launchAt: inSeconds(-1) },
          { startedBy: { id: "alice" } },
        );
        await waitFor(async () => (await client.approvals(runId)).length === 1);
        await client.decide(runId, { decision: "approve", by: { id: "marketing-lead" } });
        expect(await client.result(runId)).toMatchObject({ post: expect.stringContaining(appName) });
      } finally {
        await client.close();
        await worker.stop();
      }
    }
  });

  it("leaves a rollback's runs queued until it is promoted, then runs them", async () => {
    // A fresh app, so v1 and v2 are new whatever earlier runs left in the database.
    const appName = `version-rollback-${Date.now()}`;
    // startTestWorker runs on the database it is given, never the one the config names.
    const cfg = {
      ...config(appName, { workflows: [quick] }),
      appName,
      databaseUrl: "postgresql://nobody@127.0.0.1:1/not-this-one",
    };
    const client = await SanomaClient.connect({ ...cfg, databaseUrl });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // v1 ran first, then v2: starting v1 again is a rollback. (A new version becomes the
      // latest when it first starts.)
      for (const version of ["v1", "v2"]) {
        named(version);
        await (await startTestWorker(cfg, { databaseUrl })).stop();
      }

      named("v1");
      let worker = await startTestWorker(cfg, { databaseUrl });
      let runId: string;
      try {
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/runs version .*@v1 but the app's latest is .*@v2/));
        runId = await client.start(quick, {}, { startedBy: { id: "alice" } });
        // Queued without a version, so for the latest, v2, which is not running.
        await new Promise((r) => setTimeout(r, 2_000));
        expect((await client.run(runId))?.status).toBe("queued");
      } finally {
        await worker.stop();
      }

      warn.mockClear();
      worker = await startTestWorker(cfg, { databaseUrl, promote: true });
      try {
        // Ours, not DBOS's own note at launch, which comes before the promotion.
        const ours = warn.mock.calls.map(([m]) => String(m)).filter((m) => m.startsWith("sanoma:"));
        expect(ours.filter((m) => m.includes("latest"))).toEqual([]);
        expect((await DBOS.getLatestApplicationVersion()).versionName).toBe(`${appName}@v1`);
        expect(await client.result(runId)).toBe("done");
      } finally {
        await worker.stop();
      }
    } finally {
      warn.mockRestore();
      await client.close();
    }
  });

  it("warns at startup about unfinished runs on another version or another queue, naming them", async () => {
    // A fresh app, so the only unfinished runs are this test's.
    const appName = `version-warn-${Date.now()}`;
    named("one");
    const before = config(appName);
    let worker = await startWorker(before);
    const client = await SanomaClient.connect(before);
    const raw = await DBOSClient.create({ systemDatabaseUrl: databaseUrl, applicationName: appName });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sleeping = await client.start(
        announce,
        { title: "Old", body: "<p>x</p>", launchAt: inSeconds(-1) },
        { startedBy: { id: "alice" } },
      );
      leftPending.push(sleeping);
      await waitFor(async () => (await client.approvals(sleeping)).length === 1);
      // Queued on the single queue every app shared before queues were named per app.
      const queued = await raw.enqueue(
        { queueName: "sanoma", workflowName: "announce", applicationName: appName },
        { input: {}, startedBy: { id: "alice" } },
      );
      leftPending.push(queued.workflowID);
      await worker.stop();

      warn.mockClear();
      named("two");
      worker = await startWorker(config(appName));
      const lines = warn.mock.calls.map((args) => String(args[0])).filter((l) => l.includes("unfinished run"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(
        `sanoma: 1 unfinished run(s) of "${appName}" belong to another version and 1 wait on another queue`,
      );
      expect(lines[0]).toContain(sleeping);
      expect(lines[0]).toContain(queued.workflowID);
      expect(lines[0]).toContain(`forkWorkflow(id, step, { applicationVersion: "${appName}@two"`);
    } finally {
      warn.mockRestore();
      await raw.destroy();
      await client.close();
      await worker.stop();
    }
  });
});
