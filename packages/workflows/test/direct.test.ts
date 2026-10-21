import { randomUUID } from "node:crypto";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { fakeHost } from "@sanoma-ai/testing/host";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DATA_TABLE, LEDGER_TABLE } from "../src/db.ts";
import { describeConfig } from "../src/describe.ts";
import {
  CALL_WORKFLOW,
  defineConnector,
  defineDriver,
  defineWorkflow,
  isDirect,
  type LedgerRecord,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  withSetup,
} from "../src/index.ts";
import { outbound } from "./fixtures/outbound/resources/data.ts";
import { failure, rootWith, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. Operations called directly (`SanomaClient.call`): a read checked
// and not recorded, a write recorded with its record in one transaction, a hold made a run of the
// built-in `call` workflow, and `latest`.

const rename = {
  effect: "write",
  input: z.object({ id: z.string(), name: z.string() }),
  output: z.object({ id: z.string(), name: z.string() }),
} as const;
const acme = defineConnector("acme", {
  customer: {
    get: {
      effect: "read",
      idempotent: true,
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), name: z.string() }),
      target: ({ id }: { id: string }) => `customer/${id}`,
    },
    rename,
  },
});
const acmeDriver = defineDriver(acme, {
  customer: {
    get: async ({ id }) => {
      if (id === "broken") throw new Error("the vendor is down");
      return { id, name: "Acme Ltd" };
    },
    rename: async (input) => input,
  },
});

/** Allows, but denies a lead `lost` and holds one `won` for `lead`. */
const root = rootWith({
  "policies/policy.cedar": `@reason("leads are not lost")
forbid (principal, action == Sanoma::Action::"data.outbound.save", resource)
when { context.input.record.stage == "lost" };

@hold("lead")
forbid (principal, action == Sanoma::Action::"data.outbound.save", resource)
when { context.input.record.stage == "won" };
`,
  "resources/people.ts": `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
export const lead = sanoma.person({ id: "lead" });
`,
});

const config: SanomaConfig = {
  workflows: [],
  connectors: [withSetup(acme, { driver: () => acmeDriver })],
  collections: [outbound],
  root,
};
const lead = (company: string, stage = "researched") => ({
  company,
  contact: `ada@${company.toLowerCase()}.test`,
  stage,
  owner: "ada",
});
const ada = { id: "ada" };

describe("isDirect", () => {
  const types = new Map([["acme.widget", {}]]);
  it.each([
    ["a collection's write", { vendor: "data", resource: "outbound", effect: "write" }, true],
    ["a vendor's read", { vendor: "acme", resource: "customer", effect: "read" }, true],
    ["a vendor's write", { vendor: "acme", resource: "customer", effect: "write" }, false],
    ["a vendor's send", { vendor: "acme", resource: "mail", effect: "send" }, false],
    ["the runtime's own read", { vendor: "sanoma", resource: "source", effect: "read" }, false],
    ["a resource type's read", { vendor: "acme", resource: "widget", effect: "read" }, false],
  ] as const)("is %s: %o", (_, op, direct) => {
    expect(isDirect(op, types)).toBe(direct);
  });
});

describe("a direct call", () => {
  const databaseUrl = testDatabaseUrl("direct");
  // A worker for the call runs, its own client on a memory ledger, and this client on the default ledger.
  const app = useTestApp(config, { databaseUrl });
  let client: SanomaClient;
  let db: Pool;
  beforeAll(async () => {
    client = await SanomaClient.connect({ ...config, databaseUrl });
    db = new Pool({ connectionString: databaseUrl, max: 1 });
  });
  afterAll(async () => {
    await client?.close();
    await db?.end();
  });
  beforeEach(async () => {
    await db.query(`DELETE FROM ${DATA_TABLE} WHERE collection = 'outbound'`);
    await db.query(`DELETE FROM ${LEDGER_TABLE} WHERE run_id LIKE 'direct:%'`);
  });

  const records = async () =>
    (
      await db.query<{ record: LedgerRecord }>(`SELECT record FROM ${LEDGER_TABLE} WHERE run_id LIKE 'direct:%'`)
    ).rows.map((r) => r.record);
  const rows = async () =>
    (await db.query(`SELECT key, record, updated_by FROM ${DATA_TABLE} WHERE collection = 'outbound' ORDER BY key`))
      .rows;
  const dbos = () => (client as unknown as { dbos: DBOSClient }).dbos;

  it("reads as the person under the policy, records nothing, and never reaches DBOS", async () => {
    await client.call("data.outbound.save", { record: lead("Acme") }, { actor: ada, id: "seed" });
    const enqueue = vi.spyOn(dbos(), "enqueue");
    const list = vi.spyOn(dbos(), "listWorkflows");
    try {
      expect(await client.call("acme.customer.get", { id: "c1" }, { actor: ada, id: "r1" })).toEqual({
        id: "c1",
        name: "Acme Ltd",
      });
      expect(await client.call("data.outbound.get", { key: "Acme" }, { actor: ada })).toMatchObject({
        key: "Acme",
        updatedBy: "ada",
      });
      expect(enqueue).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    } finally {
      enqueue.mockRestore();
      list.mockRestore();
    }
    // Only the save is recorded.
    expect((await records()).map((r) => r.id)).toEqual(["direct:ada:seed:op.called:0"]);
  });

  it("fails a read whose driver fails as driver_failed, recording nothing", async () => {
    const err = await failure(client.call("acme.customer.get", { id: "broken" }, { actor: ada }));
    expect(err).toMatchObject({ code: "driver_failed", message: "acme.customer.get failed: the vendor is down" });
    expect(await records()).toEqual([]);
  });

  it("writes one op.called record and the record it saves, made by the person", async () => {
    const saved = await client.call("data.outbound.save", { record: lead("Acme") }, { actor: ada, id: "w1" });
    expect(saved).toMatchObject({ key: "Acme", record: lead("Acme"), updatedBy: "ada" });
    expect(await rows()).toEqual([{ key: "Acme", record: lead("Acme"), updated_by: "ada" }]);
    expect(await records()).toEqual([
      {
        v: 1,
        app: "sanoma",
        id: "direct:ada:w1:op.called:0",
        runId: "direct:ada:w1",
        seq: 0,
        at: expect.any(Number),
        // Admitted: as the people files declare ada, in no group.
        actor: { ...ada, groups: [] },
        workflow: "call",
        type: "op.called",
        op: "data.outbound.save",
        effect: "write",
        input: { record: lead("Acme") },
        decision: { kind: "allow", reasons: ["allow-by-default"], policyVersion: expect.any(String) },
        output: saved,
        durationMs: expect.any(Number),
      },
    ]);
  });

  it("returns what the first write with an id returned, and refuses that id with another input", async () => {
    const first = await client.call("data.outbound.save", { record: lead("Acme") }, { actor: ada, id: "w2" });
    await db.query(`UPDATE ${DATA_TABLE} SET updated_by = 'someone' WHERE collection = 'outbound'`);
    expect(await client.call("data.outbound.save", { record: lead("Acme") }, { actor: ada, id: "w2" })).toEqual(first);
    // Not written again: the row keeps what was set since.
    expect((await rows())[0]).toMatchObject({ updated_by: "someone" });
    const other = await failure(
      client.call("data.outbound.save", { record: lead("Acme", "contacted") }, { actor: ada, id: "w2" }),
    );
    expect(other).toMatchObject({ code: "invalid_input", data: { runId: "direct:ada:w2", differs: ["input"] } });
    const deleted = await failure(client.call("data.outbound.delete", { key: "Acme" }, { actor: ada, id: "w2" }));
    expect(deleted).toMatchObject({ code: "invalid_input", data: { differs: ["op", "input"] } });
    expect(await records()).toHaveLength(1);
  });

  it("saves one record of two writes with one id at once", async () => {
    const both = await Promise.all(
      [0, 1].map(() => client.call("data.outbound.save", { record: lead("Acme") }, { actor: ada, id: "w3" })),
    );
    expect(both[0]).toEqual(both[1]);
    expect(await records()).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it("keeps neither the record nor its ledger record when the ledger cannot store it", async () => {
    // A NUL in the call's id, which only the ledger's row holds (its run id), and which Postgres
    // refuses; the record was saved before it, in the same transaction.
    const err = await failure(
      client.call("data.outbound.save", { record: lead("Acme") }, { actor: ada, id: "w4\u0000" }),
    );
    expect(String(err)).toMatch(/invalid byte sequence/);
    expect(await rows()).toEqual([]);
    expect(await records()).toEqual([]);
  });

  it("throws policy_denied for a denied write, writing nothing", async () => {
    const err = await failure(client.call("data.outbound.save", { record: lead("Acme", "lost") }, { actor: ada }));
    expect(err).toMatchObject({ code: "policy_denied", data: { op: "data.outbound.save" } });
    expect(await rows()).toEqual([]);
    expect(await records()).toEqual([]);
  });

  it("makes a held write a run of call as the person, which saves it once approved", async () => {
    const won = lead("Acme", "won");
    // New on each test run: the database keeps the runs of the last.
    const held = randomUUID();
    const err = await failure(client.call("data.outbound.save", { record: won }, { actor: ada, id: held }));
    const runId = `call:ada:${held}`;
    expect(err).toMatchObject({
      code: "approval_pending",
      data: { runId, workflow: CALL_WORKFLOW, op: "data.outbound.save" },
    });
    expect(await rows()).toEqual([]);
    // The same call again names the same run, and starts no other.
    expect(await failure(client.call("data.outbound.save", { record: won }, { actor: ada, id: held }))).toMatchObject({
      code: "approval_pending",
      data: { runId },
    });
    await waitFor(async () => (await client.approvals(runId)).some((a) => a.status === "pending"));
    expect(await client.approvals(runId)).toMatchObject([
      { requestedBy: "policy", op: "data.outbound.save", approver: "lead", status: "pending", input: { record: won } },
    ]);
    expect((await client.run(runId))?.startedBy).toEqual(ada);
    await client.decide(runId, { decision: "approve", by: { id: "lead" } });
    expect(await client.result(runId)).toMatchObject({ key: "Acme", record: won, updatedBy: "ada" });
    expect(await rows()).toEqual([{ key: "Acme", record: won, updated_by: "ada" }]);
    // The same call once its run has ended answers with what the run returned, and writes nothing more.
    expect(await client.call("data.outbound.save", { record: won }, { actor: ada, id: held })).toMatchObject({
      key: "Acme",
      updatedBy: "ada",
    });
    expect(await rows()).toHaveLength(1);
    const listing = vi.spyOn(dbos(), "listWorkflows");
    try {
      expect(await client.latest(CALL_WORKFLOW)).toMatchObject({
        runId,
        output: { key: "Acme", updatedBy: "ada" },
        at: expect.any(Number),
      });
      expect(listing).toHaveBeenCalledTimes(1);
    } finally {
      listing.mockRestore();
    }
  });

  it("refuses what is not to be called directly, an unknown operation, and input its schema refuses", async () => {
    const refused = (op: string, input: unknown) => failure(client.call(op, input, { actor: ada }));
    expect(await refused("acme.customer.rename", { id: "c1", name: "B" })).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("a workflow's to call"),
    });
    expect(await refused("acme.customer.nope", {})).toMatchObject({ code: "invalid_input" });
    expect(await refused("data.outbound.save", { record: { company: "Acme" } })).toMatchObject({
      code: "invalid_input",
      data: {
        op: "data.outbound.save",
        issues: expect.arrayContaining([expect.objectContaining({ path: ["record", "stage"] })]),
      },
    });
    expect(await failure(client.call("acme.customer.get", { id: "c1" }, { actor: { id: "" } }))).toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses a resource type's operation and the runtime's own", async () => {
    const host = fakeHost(async () => ({ url: "http://localhost", stop: async () => undefined }));
    const hosted = await SanomaClient.connect({ ...config, connectors: [host.connector], databaseUrl });
    try {
      for (const op of ["testhost.app.read", "testhost.app.import", "sanoma.source.resolve"]) {
        expect(await failure(hosted.call(op, {}, { actor: ada }))).toMatchObject({
          code: "invalid_input",
          message: expect.stringContaining("cannot be called directly"),
        });
      }
    } finally {
      await hosted.close();
    }
  });

  it("finds no latest run of a workflow with none", async () => {
    expect(await app.client.latest("nothing")).toBeNull();
  });
});

describe("the built-in call workflow in a config", () => {
  it("is added when an operation may be called directly, using each that has a driver, and described", () => {
    const description = describeConfig(config);
    const entry = description.workflows.find((wf) => wf.name === CALL_WORKFLOW);
    expect(entry).toMatchObject({ builtin: true, title: "Call an operation", problems: [] });
    expect(entry?.ops).toEqual([
      "acme.customer.get",
      "data.outbound.delete",
      "data.outbound.get",
      "data.outbound.list",
      "data.outbound.save",
    ]);
    expect(description.ops.filter((op) => op.direct).map((op) => op.id)).toEqual(entry?.ops);
    expect(description.ops.find((op) => op.id === "acme.customer.rename")).toMatchObject({ direct: false });
  });

  it("is not added when none may be, and no workflow of the config may be named call", () => {
    const writes = defineConnector("acme", { customer: { rename } });
    const none = { ...config, connectors: [writes], collections: [] };
    expect(resolveConfig(none).workflows.has(CALL_WORKFLOW)).toBe(false);
    const named = defineWorkflow({
      name: "call",
      trigger: "manual",
      input: z.object({}),
      uses: [],
      run: async () => 1,
    });
    expect(() => resolveConfig({ ...config, workflows: [named] })).toThrow(
      'A workflow is named "call", the name of a built-in workflow',
    );
  });
});
