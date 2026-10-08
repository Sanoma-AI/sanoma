import { readFileSync } from "node:fs";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { testDatabaseUrl } from "@sanoma/testing";
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

  it("warns at startup about unfinished runs on another version or another queue, naming them", async () => {
    named("one");
    const before = config("version-warn");
    // On a reused database "one" is older than "two" from the last run, so this start is a
    // rollback: it must promote itself to take the runs queued below.
    let worker = await startWorker(before, { promote: true });
    const client = await SanomaClient.connect(before);
    const raw = await DBOSClient.create({ systemDatabaseUrl: databaseUrl, applicationName: "version-warn" });
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
        { queueName: "sanoma", workflowName: "announce", applicationName: "version-warn" },
        { input: {}, startedBy: { id: "alice" } },
      );
      leftPending.push(queued.workflowID);
      await worker.stop();

      warn.mockClear();
      named("two");
      worker = await startWorker(config("version-warn"));
      const lines = warn.mock.calls.map((args) => String(args[0])).filter((l) => l.includes("unfinished run"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/run\(s\) of "version-warn" belong to another version and \d+ wait on another queue/);
      expect(lines[0]).toContain(sleeping);
      expect(lines[0]).toContain(queued.workflowID);
      expect(lines[0]).toContain('forkWorkflow(id, step, { applicationVersion: "version-warn@two"');
    } finally {
      warn.mockRestore();
      await raw.destroy();
      await client.close();
      await worker.stop();
    }
  });
});
