import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabaseUrl, waitFor, withFake } from "sanoma/testing";
import { useTestApp } from "sanoma/testing/harness";
import {
  type ChatTurnContext,
  defineConnector,
  defineDriver,
  defineResource,
  defineWorkflow,
  resolveConfig,
  withSetup,
} from "sanoma/workflows";
import { defineFake } from "sanoma/workflows/fake";
import { chatRunId } from "sanoma/workflows/shared";
import type { UIMessage } from "ai";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { catalogCallId } from "../src/lib/chat.ts";
import { settle } from "../src/server/chat.ts";
import { catalogTools } from "../src/steps/agent/tools.ts";

// Needs Postgres (`pnpm db:up`). The agent catalog as the chat's engines take it (`catalogTools`),
// run against a worker's client as the in-app chat's agent for a person, without a model: the
// policy asked as the agent and as the person, the idempotency id of the chat, the turn and the
// tool call, holds shown at once, the turn's stop ending any wait; and `settle` answering a
// catalog call a restart cut short from the run it left.

const crm = defineConnector("crm", {
  customer: {
    find: {
      effect: "read",
      idempotent: true,
      input: z.object({ name: z.string() }),
      output: z.object({ name: z.string() }),
    },
  },
});
const crmDriver = defineDriver(crm, { customer: { find: async ({ name }) => ({ name }) } });

// A vendor whose hook a data file declares, so the company has drift.
const hook = defineResource({
  vendor: "hooks",
  type: "hook",
  title: "Hook",
  identity: "name",
  schema: z.object({ name: z.string() }),
  fields: { immutable: [], vendorOwned: [], writeOnly: [] },
  find: ({ name }) => name,
});
const hooks = defineConnector("hooks", { hook }, { title: "Hooks", package: "@acme/hooks" });
const hooksFake = defineFake(hooks, {
  initial: () => ({}),
  ops: () => ({
    hook: {
      import: async ({ id }) => ({ id, gone: false, state: { name: id } }),
      read: async ({ id }) => ({ id, gone: true }),
    },
  }),
});

const memo = defineWorkflow({
  name: "memo",
  trigger: "manual",
  input: z.object({ note: z.string() }),
  uses: [],
  run: async (_ctx, { note }) => ({ noted: note }),
});
const payout = defineWorkflow({
  name: "payout",
  trigger: "manual",
  input: z.object({ amount: z.number().int() }),
  uses: [],
  run: async (_ctx, { amount }) => ({ paid: amount }),
});

const root = mkdtempSync(join(tmpdir(), "sanoma-catalog-tools-"));
writeFileSync(join(root, "package.json"), '{ "name": "catalog-tools", "private": true }\n');
mkdirSync(join(root, "resources"));
writeFileSync(
  join(root, "resources/people.ts"),
  `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
export const bo = sanoma.person({ id: "bo" });
`,
);
writeFileSync(
  join(root, "resources/hooks.ts"),
  `import { hooks } from "@acme/hooks/resources";\n\nexport const deploys = hooks.hook({ name: "deploys" });\n`,
);
mkdirSync(join(root, "policies"));
writeFileSync(
  join(root, "policies/catalog.cedar"),
  `@reason("Ada looks up no customer")
forbid (principal == Sanoma::Principal::"ada", action == Sanoma::Action::"crm.customer.find", resource);

@reason("Ada writes no memo")
forbid (principal == Sanoma::Principal::"ada", action == Sanoma::Action::"workflow:memo", resource);

@hold("on-behalf-of")
forbid (principal in Sanoma::Group::"agents", action == Sanoma::Action::"workflow:payout", resource);

@hold("on-behalf-of")
forbid (principal in Sanoma::Group::"agents", action == Sanoma::Action::"workflow:drift", resource);

@hold("on-behalf-of")
forbid (principal in Sanoma::Group::"agents", action == Sanoma::Action::"crm.customer.find", resource)
when { context.input.name == "Held" };
`,
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const testApp = useTestApp(
  {
    workflows: [memo, payout],
    connectors: [withSetup(crm, { driver: () => crmDriver }), withFake(hooks, hooksFake)],
    root,
  },
  { databaseUrl: testDatabaseUrl("catalog_tools") },
);

/** A turn of the chat `chat` for the person `by`'s message `message`, as the worker's step gives it. */
const toolsFor = (by: string, chat: string, message = "m1", heldMs = 2000) => {
  const { config } = testApp;
  const step = {
    client: testApp.client,
    by: { id: by },
    config,
    resolved: resolveConfig(config),
    runId: chatRunId(chat, message),
  } as unknown as ChatTurnContext;
  return catalogTools({ step, chat: { id: chat } as never }, { heldMs });
};

const options = (toolCallId: string, abortSignal?: AbortSignal) => ({
  toolCallId,
  messages: [],
  abortSignal,
  context: {},
});

/** What a tool's `execute` yielded or returned, in order. */
async function outputs(answer: unknown): Promise<unknown[]> {
  if (answer && typeof (answer as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    const seen: unknown[] = [];
    for await (const value of answer as AsyncIterable<unknown>) seen.push(value);
    return seen;
  }
  return [await answer];
}

const chatFor = (person: string) => ({ id: "sanoma-chat", groups: ["agents"], onBehalfOf: person });

describe("the chat's catalog tools", () => {
  it("refuse the chat what a forbid refuses its person, and let another person's chat through", async () => {
    const ada = toolsFor("ada", "c-ada");
    await expect(
      outputs(ada.lookup.execute!({ op: "crm.customer.find", input: { name: "A" } }, options("t1"))),
    ).rejects.toThrow(/Ada looks up no customer/);
    await expect(
      outputs(ada.start_run.execute!({ workflow: "memo", input: { note: "x" } }, options("t2"))),
    ).rejects.toThrow(/Ada writes no memo/);
    const bo = toolsFor("bo", "c-bo");
    expect(
      (await outputs(bo.lookup.execute!({ op: "crm.customer.find", input: { name: "A" } }, options("t1")))).at(-1),
    ).toEqual({ output: { name: "A" } });
    const started = (
      await outputs(bo.start_run.execute!({ workflow: "memo", input: { note: "x" } }, options("t2")))
    ).at(-1) as { runId: string };
    expect(started).toMatchObject({ status: "finished", output: { noted: "x" } });
    expect(started.runId).toBe(catalogCallId("c-bo", "m1", "t2"));
    expect((await testApp.client.run(started.runId))?.startedBy).toEqual(chatFor("bo"));
  }, 120_000);

  it("refuse every one of the runtime's own workflows, however it is written", async () => {
    const bo = toolsFor("bo", "c-builtins");
    for (const workflow of ["save-draft", "saveDraft", "call", "chat", "drift", "apply", "login-code", "loginCode"]) {
      await expect(
        outputs(bo.start_run.execute!({ workflow, input: {} }, options(`b-${workflow}`))),
        workflow,
      ).rejects.toThrow(/the runtime's own workflow/);
    }
  }, 120_000);

  it("start a new run for a tool-call id used again in a later turn, and answer the same run within one", async () => {
    const first = toolsFor("bo", "c-again", "m1");
    const a = (
      await outputs(first.start_run.execute!({ workflow: "memo", input: { note: "same" } }, options("call_0")))
    ).at(-1) as { runId: string };
    // A retry within the turn is the same call.
    expect(
      (await outputs(first.start_run.execute!({ workflow: "memo", input: { note: "same" } }, options("call_0")))).at(
        -1,
      ),
    ).toEqual(a);
    const later = toolsFor("bo", "c-again", "m2");
    const b = (
      await outputs(later.start_run.execute!({ workflow: "memo", input: { note: "same" } }, options("call_0")))
    ).at(-1) as { runId: string };
    expect(b.runId).not.toBe(a.runId);
    expect(b).toMatchObject({ status: "finished", output: { noted: "same" } });
  }, 120_000);

  it("show a held start at once, and past the wait answer that it waits, and for whom", async () => {
    const bo = toolsFor("bo", "c-held", "m1", 1500);
    const runId = catalogCallId("c-held", "m1", "h1");
    const seen = await outputs(bo.start_run.execute!({ workflow: "payout", input: { amount: 3 } }, options("h1")));
    expect(seen).toEqual([
      { held: { runId } },
      { held: { runId }, runId, status: "waiting for approval", waitsFor: ["bo"] },
    ]);
  }, 120_000);

  it("show a drift the policy holds at once, not after the result's wait", async () => {
    const bo = toolsFor("bo", "c-drift", "m1", 600_000);
    const generator = bo.drift.execute!({}, options("d1")) as AsyncGenerator<unknown>;
    const started = Date.now();
    expect((await generator.next()).value).toEqual({ held: { runId: catalogCallId("c-drift", "m1", "d1") } });
    expect(Date.now() - started).toBeLessThan(10_000);
    await generator.return(undefined);
  }, 120_000);

  it("end a wait the turn's stop ends: a held start's, and wait_run's", async () => {
    const bo = toolsFor("bo", "c-stop", "m1", 600_000);
    const stop = new AbortController();
    const generator = bo.start_run.execute!(
      { workflow: "payout", input: { amount: 4 } },
      options("s1", stop.signal),
    ) as AsyncGenerator<unknown>;
    const runId = catalogCallId("c-stop", "m1", "s1");
    expect((await generator.next()).value).toEqual({ held: { runId } });
    let started = Date.now();
    setTimeout(() => stop.abort(), 200);
    await expect(generator.next()).rejects.toThrow(/abort/i);
    expect(Date.now() - started).toBeLessThan(3000);

    // The run still waits for its approval: wait_run would wait its whole 20 s, but for the stop.
    const waiting = new AbortController();
    started = Date.now();
    setTimeout(() => waiting.abort(), 200);
    await expect(outputs(bo.wait_run.execute!({ runId }, options("s2", waiting.signal)))).rejects.toThrow(/abort/i);
    expect(Date.now() - started).toBeLessThan(3000);
    // Unstopped, it answers that the run is running once its wait is over.
    expect((await outputs(bo.wait_run.execute!({ runId, waitMs: 300 }, options("s3")))).at(-1)).toEqual({
      runId,
      status: "running",
    });
  }, 120_000);
});

/** A transcript: the person's message `message`, then a reply cut short in the tool call `toolCallId`. */
const cut = (message: string, tool: string, toolCallId: string, input: object): UIMessage[] => [
  { id: message, role: "user", parts: [{ type: "text", text: "Go" }] },
  {
    id: "reply",
    role: "assistant",
    parts: [{ type: `tool-${tool}`, toolCallId, state: "input-available", input }],
  } as UIMessage,
];
const partOf = (messages: UIMessage[]) => messages.at(-1)!.parts[0] as Record<string, unknown>;

describe("settle, for a catalog call a restart cut short", () => {
  it("answers a start from the run it left, by its id and status, so the model does not start it again", async () => {
    const bo = toolsFor("bo", "c-cut", "m1");
    await outputs(bo.start_run.execute!({ workflow: "memo", input: { note: "once" } }, options("t1")));
    const runId = catalogCallId("c-cut", "m1", "t1");
    const settled = partOf(await settle(testApp.client, cut("m1", "start_run", "t1", { workflow: "memo" }), "c-cut"));
    expect(settled).toMatchObject({ state: "output-available", output: { runId, status: "finished" } });
  }, 120_000);

  it("keeps a held start's or held lookup's run as its approval card, and settles it once it ended", async () => {
    const bo = toolsFor("bo", "c-cut-held", "m1", 500);
    await outputs(bo.start_run.execute!({ workflow: "payout", input: { amount: 5 } }, options("p1")));
    await outputs(bo.lookup.execute!({ op: "crm.customer.find", input: { name: "Held" } }, options("l1")));
    const start = catalogCallId("c-cut-held", "m1", "p1");
    const call = `call:sanoma-chat:${catalogCallId("c-cut-held", "m1", "l1")}`;
    expect((await testApp.client.run(call))?.startedBy).toEqual(chatFor("bo"));
    const heldStart = await settle(testApp.client, cut("m1", "start_run", "p1", {}), "c-cut-held");
    expect(partOf(heldStart)).toMatchObject({ output: { held: { runId: start } }, preliminary: true });
    expect(partOf(await settle(testApp.client, cut("m1", "lookup", "l1", {}), "c-cut-held"))).toMatchObject({
      output: { held: { runId: call } },
      preliminary: true,
    });
    // Once Bo approves the held lookup, settling again answers its result.
    await waitFor(async () => (await testApp.client.approvals(call)).some((a) => a.status === "pending"));
    await testApp.client.decide(call, { decision: "approve", by: { id: "bo" } });
    await waitFor(async () => (await testApp.client.run(call))?.status === "finished");
    const held = await settle(testApp.client, cut("m1", "lookup", "l1", {}), "c-cut-held");
    const answered = await settle(testApp.client, held, "c-cut-held");
    expect(partOf(answered)).toMatchObject({ preliminary: false, output: { output: { name: "Held" } } });
  }, 120_000);

  it("fails a call that left no run as interrupted, as before", async () => {
    const settled = partOf(await settle(testApp.client, cut("m9", "start_run", "nothing", {}), "c-none"));
    expect(settled).toMatchObject({
      state: "output-error",
      errorText: "start_run was interrupted: the server restarted before it finished",
    });
  }, 120_000);
});
