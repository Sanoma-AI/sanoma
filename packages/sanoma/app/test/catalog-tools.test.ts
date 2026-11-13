import { randomUUID } from "node:crypto";
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
import { CHAT_AGENT, chatRunId, heldCallRunId } from "sanoma/workflows/shared";
import type { UIMessage } from "ai";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { catalogCallId, heldRunOf } from "../src/lib/chat.ts";
import { CATALOG, callRunId } from "../src/server/catalog.ts";
import { settle } from "../src/server/chat.ts";
import { harnessInstructions } from "../src/steps/agent/prompt.ts";
import { catalogTools } from "../src/steps/agent/tools.ts";
import { chat as chatTurn } from "../src/steps/agent/turn.ts";

// Needs Postgres (`pnpm db:up`). The agent catalog as the chat's engines take it (`catalogTools`),
// run against a worker's client as the in-app chat's agent for a person, without a model: the
// policy asked as the agent and as the person, the idempotency id of the chat, the turn and the
// tool call, holds shown at once, the turn's stop ending any wait; and `settle` answering a
// catalog call a restart cut short from the run it left, and a held one answered past its wait.

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
/** A workflow whose run starts and then fails. */
const broken = defineWorkflow({
  name: "broken",
  trigger: "manual",
  input: z.object({}),
  uses: [],
  run: async () => {
    throw new Error("the ledger is closed");
  },
});

const root = mkdtempSync(join(tmpdir(), "sanoma-catalog-tools-"));
writeFileSync(join(root, "package.json"), '{ "name": "catalog-tools", "private": true }\n');
mkdirSync(join(root, "resources"));
writeFileSync(
  join(root, "resources/people.ts"),
  `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
export const bo = sanoma.person({ id: "bo" });
export const finance = sanoma.group({ name: "finance", members: ["ada"] });
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

@hold("finance")
forbid (principal, action == Sanoma::Action::"crm.customer.find", resource)
when { context.input.name == "Audit" };
`,
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const testApp = useTestApp(
  {
    workflows: [memo, payout, broken],
    connectors: [withSetup(crm, { driver: () => crmDriver }), withFake(hooks, hooksFake)],
    root,
  },
  { databaseUrl: testDatabaseUrl("catalog_tools") },
);

/** This file's run, so its chats and the runs their calls leave are new on a test database used before. */
const RUN = randomUUID().slice(0, 8);

/** The test app's config resolved, once. */
let resolved: ReturnType<typeof resolveConfig> | undefined;

/** A turn of the chat `chat` for the person `by`'s message `message`, as the worker's step gives it. */
const stepFor = (by: string, chat: string, message = "m1") => {
  const { config } = testApp;
  return {
    client: testApp.client,
    by: { id: by },
    config,
    resolved: (resolved ??= resolveConfig(config)),
    runId: chatRunId(chat, message),
  } as unknown as ChatTurnContext;
};
const toolsFor = (by: string, chat: string, message = "m1", heldMs = 2000) =>
  catalogTools({ step: stepFor(by, chat, message), chat: { id: chat } as never, message }, { heldMs });

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

/** What a tool's `execute` answered last: its result. */
const lastOf = async (answer: unknown) => (await outputs(answer)).at(-1);

const chatFor = (person: string) => ({ id: CHAT_AGENT, groups: ["agents"], onBehalfOf: person });

describe("the chat's catalog tools", () => {
  it("refuse the chat what a forbid refuses its person, and let another person's chat through", async () => {
    const ada = toolsFor("ada", `c-ada-${RUN}`);
    await expect(
      outputs(ada.lookup.execute!({ op: "crm.customer.find", input: { name: "A" } }, options("t1"))),
    ).rejects.toThrow(/Ada looks up no customer/);
    await expect(
      outputs(ada.start_run.execute!({ workflow: "memo", input: { note: "x" } }, options("t2"))),
    ).rejects.toThrow(/Ada writes no memo/);
    const bo = toolsFor("bo", `c-bo-${RUN}`);
    expect(await lastOf(bo.lookup.execute!({ op: "crm.customer.find", input: { name: "A" } }, options("t1")))).toEqual({
      output: { name: "A" },
    });
    const started = (await lastOf(
      bo.start_run.execute!({ workflow: "memo", input: { note: "x" } }, options("t2")),
    )) as { runId: string };
    expect(started).toMatchObject({ status: "finished", output: { noted: "x" } });
    expect(started.runId).toBe(catalogCallId(`c-bo-${RUN}`, "m1", "t2"));
    expect((await testApp.client.run(started.runId))?.startedBy).toEqual(chatFor("bo"));
  }, 120_000);

  it("refuse every one of the runtime's own workflows, however it is written", async () => {
    const bo = toolsFor("bo", `c-builtins-${RUN}`);
    for (const workflow of ["save-draft", "saveDraft", "call", "chat", "drift", "apply", "login-code", "loginCode"]) {
      await expect(
        outputs(bo.start_run.execute!({ workflow, input: {} }, options(`b-${workflow}`))),
        workflow,
      ).rejects.toThrow(/the runtime's own workflow/);
    }
  }, 120_000);

  it("start a new run for a tool-call id used again in a later turn, and answer the same run within one", async () => {
    const first = toolsFor("bo", `c-again-${RUN}`, "m1");
    const start = (tools: ReturnType<typeof toolsFor>) =>
      lastOf(tools.start_run.execute!({ workflow: "memo", input: { note: "same" } }, options("call_0")));
    const a = (await start(first)) as { runId: string };
    // A retry within the turn is the same call.
    expect(await start(first)).toEqual(a);
    const b = (await start(toolsFor("bo", `c-again-${RUN}`, "m2"))) as { runId: string };
    expect(b.runId).not.toBe(a.runId);
    expect(b).toMatchObject({ status: "finished", output: { noted: "same" } });
  }, 120_000);

  it("answer a run that started and then failed by its id and that it failed, as an output, never a refusal", async () => {
    const bo = toolsFor("bo", `c-failed-${RUN}`);
    const runId = catalogCallId(`c-failed-${RUN}`, "m1", "f1");
    expect(await lastOf(bo.start_run.execute!({ workflow: "broken", input: {} }, options("f1")))).toEqual({
      runId,
      status: "failed",
      error: expect.stringContaining("the ledger is closed"),
    });
    expect((await testApp.client.run(runId))?.status).toBe("failed");
  }, 120_000);

  it("are described as the chat has them: no id to send again, and a hold an output, not an error", () => {
    const bo = toolsFor("bo", `c-described-${RUN}`);
    for (const name of ["lookup", "drift", "start_run"] as const) {
      const { description } = bo[name];
      expect(description, name).not.toMatch(/the same id|error names/);
      expect(description, name).toContain("waiting for approval");
      expect(description, name).toContain(CATALOG[name].description);
    }
    expect(bo.start_run.description).toMatch(/status "failed"/);
    expect(bo.describe.description).toBe(CATALOG.describe.description);
  });

  it("show a held start at once, and past the wait answer that it waits, and for whom", async () => {
    const bo = toolsFor("bo", `c-held-${RUN}`, "m1", 100);
    const runId = catalogCallId(`c-held-${RUN}`, "m1", "h1");
    const seen = await outputs(bo.start_run.execute!({ workflow: "payout", input: { amount: 3 } }, options("h1")));
    expect(seen).toEqual([
      { held: { runId } },
      { held: { runId }, runId, status: "waiting for approval", waitsFor: ["bo"] },
    ]);
  }, 120_000);

  it("name a group a held lookup still waits for as the approvals' pages do", async () => {
    const bo = toolsFor("bo", `c-group-${RUN}`, "m1", 100);
    const runId = heldCallRunId(CHAT_AGENT, catalogCallId(`c-group-${RUN}`, "m1", "g1"));
    expect(
      await outputs(bo.lookup.execute!({ op: "crm.customer.find", input: { name: "Audit" } }, options("g1"))),
    ).toEqual([
      { held: { runId } },
      { held: { runId }, runId, status: "waiting for approval", waitsFor: ["group finance"] },
    ]);
  }, 120_000);

  it("show a drift the policy holds at once, not after the result's wait", async () => {
    const bo = toolsFor("bo", `c-drift-${RUN}`, "m1", 600_000);
    const generator = bo.drift.execute!({}, options("d1")) as AsyncGenerator<unknown>;
    const started = Date.now();
    expect((await generator.next()).value).toEqual({ held: { runId: catalogCallId(`c-drift-${RUN}`, "m1", "d1") } });
    expect(Date.now() - started).toBeLessThan(10_000);
    await generator.return(undefined);
  }, 120_000);

  it("end a wait the turn's stop ends: a held start's, and wait_run's", async () => {
    const bo = toolsFor("bo", `c-stop-${RUN}`, "m1", 600_000);
    const stop = new AbortController();
    const generator = bo.start_run.execute!(
      { workflow: "payout", input: { amount: 4 } },
      options("s1", stop.signal),
    ) as AsyncGenerator<unknown>;
    const runId = catalogCallId(`c-stop-${RUN}`, "m1", "s1");
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
    expect(await lastOf(bo.wait_run.execute!({ runId, waitMs: 300 }, options("s3")))).toEqual({
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

/** A coding agent's `start_run` step answered with `output`, as the transcript keeps it. */
const toldPart = (output: unknown) => ({
  type: "dynamic-tool",
  toolName: "start_run",
  toolCallId: "t",
  state: "output-available",
  input: { workflow: "payout" },
  output,
});

describe("settle, for a catalog call a restart cut short", () => {
  it("answers a start from the run it left, by its id and status, so the model does not start it again", async () => {
    const bo = toolsFor("bo", `c-cut-${RUN}`, "m1");
    await outputs(bo.start_run.execute!({ workflow: "memo", input: { note: "once" } }, options("t1")));
    const runId = catalogCallId(`c-cut-${RUN}`, "m1", "t1");
    const settled = partOf(
      await settle(testApp.client, cut("m1", "start_run", "t1", { workflow: "memo" }), `c-cut-${RUN}`),
    );
    expect(settled).toMatchObject({ state: "output-available" });
    // The start's one shape, as the tool itself answers it.
    expect(settled.output).toEqual({ runId, status: "finished", output: { noted: "once" } });
  }, 120_000);

  it("names the run each id-taking tool leaves from the catalog itself", () => {
    const held = heldCallRunId(CHAT_AGENT, "an-id");
    for (const { name, idempotencyId } of Object.values(CATALOG)) {
      const left = idempotencyId === undefined ? undefined : name === "lookup" ? held : "an-id";
      expect(callRunId(name, "an-id", CHAT_AGENT), name).toBe(left);
    }
    // As a coding agent names a tool its bridge serves it.
    expect(callRunId("mcp__sanoma__start_run", "an-id", CHAT_AGENT)).toBe("an-id");
    expect(callRunId("read_file", "an-id", CHAT_AGENT)).toBeUndefined();
  });

  it("revisits a held start and a held lookup answered past their wait: as they were while they wait, then the run's state", async () => {
    const chat = `c-past-${RUN}`;
    const bo = toolsFor("bo", chat, "m1", 100);
    const start = { workflow: "payout", input: { amount: 7 } };
    const find = { op: "crm.customer.find", input: { name: "Held" } };
    const waits = {
      start: await lastOf(bo.start_run.execute!(start, options("w1"))),
      lookup: await lastOf(bo.lookup.execute!(find, options("w2"))),
    };
    const runId = catalogCallId(chat, "m1", "w1");
    const call = heldCallRunId(CHAT_AGENT, catalogCallId(chat, "m1", "w2"));
    expect(waits.start).toMatchObject({ runId, status: "waiting for approval" });
    expect(waits.lookup).toMatchObject({ runId: call, status: "waiting for approval" });
    // The reply as its turn left it: both answers final, in a reply that is no longer the last.
    const transcript: UIMessage[] = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "Pay" }] },
      {
        id: "r1",
        role: "assistant",
        parts: [
          { type: "tool-start_run", toolCallId: "w1", state: "output-available", input: start, output: waits.start },
          { type: "tool-lookup", toolCallId: "w2", state: "output-available", input: find, output: waits.lookup },
        ],
      } as UIMessage,
      { id: "m2", role: "user", parts: [{ type: "text", text: "And?" }] },
      { id: "r2", role: "assistant", parts: [{ type: "text", text: "It waits.", state: "done" }] },
    ];
    expect((await settle(testApp.client, transcript, chat))[1]).toBe(transcript[1]);
    for (const held of [runId, call]) {
      await waitFor(async () => (await testApp.client.approvals(held)).some((a) => a.status === "pending"));
      await testApp.client.decide(held, { decision: "approve", by: { id: "bo" } });
      await waitFor(async () => (await testApp.client.run(held))?.status === "finished");
    }
    const [started, looked] = (await settle(testApp.client, transcript, chat))[1]!.parts as { output: unknown }[];
    expect(started!.output).toEqual({ runId, status: "finished", output: { paid: 7 } });
    expect(looked!.output).toEqual({ output: { name: "Held" } });
    expect(heldRunOf(started!.output)).toBeUndefined();
  }, 120_000);

  it("tells a coding agent's next turn, whose history is text, the run a start left and where it stands", () => {
    const chat = `c-told-${RUN}`;
    const history = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "Pay Bo" }] },
      {
        id: "r1",
        role: "assistant",
        parts: [
          toldPart({ held: { runId: "run-1" }, runId: "run-1", status: "waiting for approval", waitsFor: ["bo"] }),
          toldPart({ runId: "run-2", status: "failed", error: "the ledger is closed" }),
          { type: "text", text: "It waits for you." },
        ],
      },
    ];
    const told = harnessInstructions(stepFor("bo", chat), { id: "bo" }, { id: chat } as never, history as never, {
      catalog: true,
    });
    expect(told).toContain("You: It waits for you.");
    expect(told).toContain("[start_run: run run-1 is waiting for approval]");
    expect(told).toContain("[start_run: run run-2 is failed: the ledger is closed]");
  });

  it("keeps a held start's or held lookup's run as its approval card, and settles it once it ended", async () => {
    const bo = toolsFor("bo", `c-cut-held-${RUN}`, "m1", 500);
    await outputs(bo.start_run.execute!({ workflow: "payout", input: { amount: 5 } }, options("p1")));
    await outputs(bo.lookup.execute!({ op: "crm.customer.find", input: { name: "Held" } }, options("l1")));
    const start = catalogCallId(`c-cut-held-${RUN}`, "m1", "p1");
    const call = heldCallRunId(CHAT_AGENT, catalogCallId(`c-cut-held-${RUN}`, "m1", "l1"));
    expect((await testApp.client.run(call))?.startedBy).toEqual(chatFor("bo"));
    const heldStart = await settle(testApp.client, cut("m1", "start_run", "p1", {}), `c-cut-held-${RUN}`);
    expect(partOf(heldStart)).toMatchObject({ output: { held: { runId: start } }, preliminary: true });
    expect(partOf(await settle(testApp.client, cut("m1", "lookup", "l1", {}), `c-cut-held-${RUN}`))).toMatchObject({
      output: { held: { runId: call } },
      preliminary: true,
    });
    // Once Bo approves the held lookup, settling again answers its result.
    await waitFor(async () => (await testApp.client.approvals(call)).some((a) => a.status === "pending"));
    await testApp.client.decide(call, { decision: "approve", by: { id: "bo" } });
    await waitFor(async () => (await testApp.client.run(call))?.status === "finished");
    const held = await settle(testApp.client, cut("m1", "lookup", "l1", {}), `c-cut-held-${RUN}`);
    const answered = await settle(testApp.client, held, `c-cut-held-${RUN}`);
    expect(partOf(answered)).toMatchObject({ preliminary: false, output: { output: { name: "Held" } } });
  }, 120_000);

  it("answers a resumed turn's own start from its run, by the turn's message, whatever was said before it", async () => {
    const chat = `c-resumed-${RUN}`;
    const bo = toolsFor("bo", chat, "m2");
    await outputs(bo.start_run.execute!({ workflow: "memo", input: { note: "resumed" } }, options("t1")));
    const { chats } = testApp.client;
    await chats.open({ id: chat, person: "bo", engine: "loop", title: "Resumed" });
    // An earlier turn, then this one's message and its reply, cut short in the start by the worker's restart.
    const [asked, reply] = cut("m2", "start_run", "t1", { workflow: "memo" });
    await chats.upsert(chat, [
      { id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] },
      { id: "r1", role: "assistant", parts: [{ type: "text", text: "Hello", state: "done" }] },
      asked!,
      reply!,
    ]);
    const step = { client: testApp.client, runId: chatRunId(chat, "m2"), resumed: true } as unknown as ChatTurnContext;
    expect(await chatTurn(step, { chat, message: "m2" })).toEqual({ interrupted: true });
    expect(partOf((await chats.load(chat)) as UIMessage[])).toMatchObject({
      state: "output-available",
      output: { runId: catalogCallId(chat, "m2", "t1"), status: "finished" },
    });
  }, 120_000);

  it("answers a call by the turn its reply records, though a later turn is the one resumed", async () => {
    const chat = `c-recorded-${RUN}`;
    const bo = toolsFor("bo", chat, "m1");
    await outputs(bo.start_run.execute!({ workflow: "memo", input: { note: "first" } }, options("t1")));
    const { chats } = testApp.client;
    await chats.open({ id: chat, person: "bo", engine: "loop", title: "Recorded" });
    // m1's turn was stopped by m2 in its start; m2's turn began, and the worker died before it settled that reply.
    const [asked, reply] = cut("m1", "start_run", "t1", { workflow: "memo" });
    await chats.upsert(chat, [
      asked!,
      { ...reply!, metadata: { turn: "m1" } },
      { id: "m2", role: "user", parts: [{ type: "text", text: "And then?" }] },
    ]);
    const step = { client: testApp.client, runId: chatRunId(chat, "m2"), resumed: true } as unknown as ChatTurnContext;
    expect(await chatTurn(step, { chat, message: "m2" })).toEqual({ interrupted: true });
    const stored = (await chats.load(chat)) as UIMessage[];
    expect(stored.find((m) => m.id === "reply")!.parts[0]).toMatchObject({
      state: "output-available",
      output: { runId: catalogCallId(chat, "m1", "t1"), status: "finished", output: { noted: "first" } },
    });
  }, 120_000);

  it("fails a call that left no run as interrupted, as before", async () => {
    const settled = partOf(await settle(testApp.client, cut("m9", "start_run", "nothing", {}), `c-none-${RUN}`));
    expect(settled).toMatchObject({
      state: "output-error",
      errorText: "start_run was interrupted: the server restarted before it finished",
    });
  }, 120_000);
});
