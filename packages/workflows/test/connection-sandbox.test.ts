import { randomUUID } from "node:crypto";
import { z } from "zod";
import { expect, it, vi } from "vitest";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import {
  defineAuthentication,
  defineConnection,
  defineConnector,
  defineDriver,
  defineSteps,
  defineWorkflow,
  memoryLedger,
  memorySecretStore,
  SanomaClient,
  startWorker,
  withSetup,
  type DriverFn,
} from "../src/index.ts";
import { defineFake } from "../src/fake.ts";
import { ConnectionRegistry } from "../src/connection.ts";
import { secret } from "../src/secret.ts";
import { tree } from "./tree.ts";

it("seeds and runs two named sandbox accounts without reading production connections or credentials", async () => {
  const ops = defineConnector("inbox", {
    note: {
      save: {
        effect: "write",
        input: z.object({ id: z.string(), text: z.string() }),
        output: z.object({ text: z.string() }),
      },
      read: { effect: "read", input: z.object({ id: z.string() }), output: z.object({ text: z.string() }) },
    },
  });
  const live = vi.fn<DriverFn<{ id: string }, { text: string }>>(async () => {
    throw new Error("live driver");
  });
  const verify = vi.fn<(value: string) => Promise<{ account: string; scopes: string[] }>>(async () => {
    throw new Error("live verifier");
  });
  const connector = withSetup(ops, {
    authentication: {
      key: defineAuthentication({
        kind: "api-key",
        version: 1,
        schema: z.string(),
        storage: { writable: false, conditionalWrites: false, maxBytes: 256 },
        verify,
      }),
    },
    driver: () => defineDriver(ops, { note: { save: live, read: live } }, { authentication: ["key"] }),
    fake: () =>
      defineFake(ops, {
        initial: () => ({ notes: {} as Record<string, string> }),
        ops: (state) => ({
          note: {
            save: async ({ id, text }) => {
              state.notes[id] = text;
              return { text };
            },
            read: async ({ id }) => ({ text: state.notes[id] ?? "missing" }),
          },
        }),
      }),
  });
  const support = defineConnection(connector, {
    name: "support",
    method: "key",
    credentials: secret("SUPPORT"),
    account: "support@example.test",
  });
  const sales = defineConnection(connector, {
    name: "sales",
    method: "key",
    credentials: secret("SALES"),
    account: "sales@example.test",
  });
  const workflow = defineWorkflow({
    name: "read-inboxes",
    trigger: "manual",
    input: z.object({}),
    uses: [connector.note.read],
    run: async (ctx) => {
      const first = await ctx.inbox.note.read({ id: "same" }, { connection: support });
      const second = await ctx.inbox.note.read({ id: "same" }, { connection: sales });
      return { first, second };
    },
  });
  const store = memorySecretStore();
  const reads = vi.spyOn(store, "read");
  const select = vi.spyOn(ConnectionRegistry.prototype, "select");
  const root = tree(`sandbox-accounts-${randomUUID()}`, {
    "scenarios/accounts.feature": `Feature: Named inboxes
  Scenario: Independent inboxes
    Given support contains "help"
    And sales contains "deal"
    When read-inboxes runs with
      """
      {}
      """
    Then the run succeeds
`,
  });
  const config = {
    root,
    databaseUrl: testDatabaseUrl("connection_sandbox"),
    connectors: [connector],
    connections: [support, sales],
    workflows: [workflow],
    secrets: { store },
    ledger: memoryLedger(),
    steps: [
      defineSteps("accounts", ({ given }) => {
        given("{word} contains {string}", (name: string, text: string) => ({
          op: connector.note.save,
          input: { id: "same", text },
          connection: name === "support" ? support : sales,
        }));
      }),
    ],
  };
  const client = await SanomaClient.connect(config);
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    worker = await startWorker(config);
    const runs = await Promise.all(
      [1, 2].map(() => client.start(workflow, {}, { startedBy: "alice", sandbox: "Independent inboxes" })),
    );
    expect(await Promise.all(runs.map((id) => client.result(id, 10_000)))).toEqual([
      { first: { text: "help" }, second: { text: "deal" } },
      { first: { text: "help" }, second: { text: "deal" } },
    ]);
    expect(live).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect((await client.ledger(runs[0]!)).filter((r) => r.type === "op.called")).toMatchObject([
      { connection: { id: "inbox/support", account: "support@example.test" } },
      { connection: { id: "inbox/sales", account: "sales@example.test" } },
    ]);
  } finally {
    await worker?.stop();
    await client.close();
    select.mockRestore();
  }
});
