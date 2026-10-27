import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestWorker } from "@sanoma-ai/testing";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  dbosClient,
  defineWorkflow,
  memoryLedger,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  type Worker,
} from "../src/index.ts";
import { fakeRemote, memorySource } from "./fakes/remote.ts";
import { freshDatabase, pending, rootWith, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. A change run outlives the restart its own deploy causes: a worker
// on new company code (another version of the app) takes over the change runs whose change code
// is its own, keeping their ids, histories and unread messages; nothing else moves.

const here = dirname(fileURLToPath(import.meta.url));
const PEOPLE = `import { sanoma } from "sanoma/resources";

export const alice = sanoma.person({ id: "alice" });
`;

/** A company workflow, which waits: its runs stay on the version that started them. */
const waits = defineWorkflow({
  name: "waits",
  trigger: "manual",
  input: z.object({}),
  uses: ["sleep"],
  run: async (ctx) => {
    await ctx.sleep({ hours: 1 });
  },
});
/** What the merge adds to the company's code: v2 has it, v1 does not. */
const added = defineWorkflow({
  name: "added",
  trigger: "manual",
  input: z.object({}),
  uses: [],
  run: async () => "added",
});

/** What a worker says it carried from now on, from `info` (which `logLevel: "info"` shows). */
function carriedLines() {
  const spy = vi.spyOn(console, "info").mockImplementation(() => {});
  return () => spy.mock.calls.map(([m]) => String(m)).filter((m) => m.startsWith("sanoma: carried"));
}

describe("carrying change runs onto a new version", () => {
  const databaseUrl = freshDatabase("change-carry");
  const root = rootWith({ "resources/people.ts": PEOPLE });
  const remote = fakeRemote();
  const repo = memorySource({ root: here, remote });
  const ledger = memoryLedger();
  const base = { connectors: [remote.connector], ledger, root, databaseUrl } satisfies SanomaConfig;
  const v1: SanomaConfig = { ...base, workflows: [waits] };
  const v2: SanomaConfig = { ...base, workflows: [waits, added] };
  const [one, two] = [resolveConfig(v1), resolveConfig(v2)];
  const workers: Worker[] = [];
  let client: SanomaClient;
  beforeAll(async () => {
    client = await SanomaClient.connect(v2);
  });
  const leftPending: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(workers.splice(0).map((w) => w.stop()));
  });
  afterAll(async () => {
    const raw = await dbosClient(databaseUrl);
    try {
      await raw.cancelWorkflows(leftPending);
    } finally {
      await raw.destroy();
    }
    await client.close();
    repo.remove();
  });

  /** A worker on `config`, the app's latest: a deploy's worker is the newest version. */
  const start = async (config: SanomaConfig, options: { logLevel?: string } = {}) => {
    const worker = await startTestWorker(config, { databaseUrl, source: repo.source, promote: true, ...options });
    workers.push(worker);
    return worker;
  };
  const stop = async (worker: Worker) => {
    workers.splice(workers.indexOf(worker), 1);
    await worker.stop();
  };
  /** The run's status row: its version, status and attributes. */
  const row = async (runId: string) => {
    const raw = await dbosClient(databaseUrl);
    try {
      return await raw.getWorkflow(runId);
    } finally {
      await raw.destroy();
    }
  };
  const open = async (id: string) => client.openChange({ id, title: `Change ${id}` }, { startedBy: "alice" });

  it("keeps the change code apart from the company's workflows", () => {
    expect(one.version).not.toBe(two.version);
    expect(one.changeCode).toBe(two.changeCode);
    expect(one.changeCode).toMatch(/^[0-9a-f]{64}$/);
  });

  it("carries a change run waiting at Publish onto a worker on new company code, which finishes it", async () => {
    const head = repo.edit("carried", { "notes/carried.md": "\n" });
    const worker = await start(v1);
    const runId = await open("carried");
    await waitFor(pending(() => client, runId));
    const company = await client.start(waits, {}, { startedBy: "alice" });
    leftPending.push(company);
    await waitFor(async () => (await row(company))?.status === "PENDING");
    expect(await row(runId)).toMatchObject({
      status: "PENDING",
      applicationVersion: one.version,
      attributes: { changeCode: one.changeCode },
    });
    await stop(worker);

    // Approved while no worker runs: the run has not read it yet, so the decision waits for it.
    const decided = await client.decide(runId, { decision: "approve", by: { id: "alice" } }, undefined, {
      timeoutSeconds: 1,
    });
    expect(decided.status).toBe("pending");

    const carried = carriedLines();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await start(v2, { logLevel: "info" });
    expect(carried()).toEqual([`sanoma: carried 1 change run(s) onto version ${two.version}: ${runId}`]);
    expect(await client.result(runId)).toMatchObject({ outcome: "merged", head });
    expect(await row(runId)).toMatchObject({ status: "SUCCESS", applicationVersion: two.version });
    expect(remote.merges).toHaveLength(1);
    // The company's run stays on its version, warned about as before.
    expect(await row(company)).toMatchObject({ status: "PENDING", applicationVersion: one.version });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(company));
  });

  it("leaves a change run whose change code differs, and warns about it", async () => {
    repo.edit("other", { "notes/other.md": "\n" });
    const worker = await start(v1);
    const runId = await open("other");
    leftPending.push(runId);
    await waitFor(pending(() => client, runId));
    await stop(worker);
    // Started by other change code: the runtime's own, before an upgrade.
    const db = new Pool({ connectionString: databaseUrl });
    try {
      await db.query(
        `UPDATE dbos.workflow_status SET attributes = attributes || '{"changeCode":"other"}' WHERE workflow_uuid = $1`,
        [runId],
      );
    } finally {
      await db.end();
    }

    const carried = carriedLines();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await start(v2, { logLevel: "info" });
    expect(carried()).toEqual([]);
    expect(await row(runId)).toMatchObject({ status: "PENDING", applicationVersion: one.version });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`another version.*${runId}`, "s")));
  });

  it("carries nothing on a restart with the same version, and the run goes on", async () => {
    const head = repo.edit("same", { "notes/same.md": "\n" });
    const worker = await start(v2);
    const runId = await open("same");
    await waitFor(pending(() => client, runId));
    await stop(worker);

    const carried = carriedLines();
    await start(v2, { logLevel: "info" });
    expect(carried()).toEqual([]);
    await waitFor(pending(() => client, runId));
    await client.decide(runId, { decision: "approve", by: { id: "alice" } });
    expect(await client.result(runId)).toMatchObject({ outcome: "merged", head });
    expect(await row(runId)).toMatchObject({ applicationVersion: two.version });
  });
});
