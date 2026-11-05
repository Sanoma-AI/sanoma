import { useTestApp } from "@sanoma-ai/testing/harness";
import { describe, expect, it } from "vitest";
import {
  type AppSteps,
  CHAT_WORKFLOW,
  type ChatTurnContext,
  type ChatTurnInput,
  chatRunId,
  errorCode,
  memoryLedger,
  NO_CHAT_STEPS,
  type Source,
} from "../src/index.ts";
import { visitorPrincipal } from "../src/shared.ts";
import { ALICE, failure, freshDatabase, rootWith, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. The built-in `chat`: a turn of a person's chat, started with
// `SanomaClient.startTurn` as the chat's person and run by the worker with the app's steps (a fake
// `chat` here, the app's own in packages/app/test/chat.test.ts): its id names the chat and the
// message, it waits for the turn before it, which it tells to stop; a pasted code reaches the turn
// sealed, a restart under it resumes it as begun, and a worker without the steps fails it at once.

const PEOPLE = `${ALICE}export const bob = sanoma.person({ id: "bob" });\n`;
const root = rootWith({ "resources/people.ts": PEOPLE });
const config = () => ({ workflows: [], connectors: [], root, ledger: memoryLedger() });

/** A person's message of `text`, its id `id`. */
const said = (id: string, text: string): ChatTurnInput["message"] => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

const failing = async () => {
  throw new Error("Not a chat's step");
};

describe("a chat turn, on a worker with the app's steps", () => {
  /** What each turn's step was given, by its run, in the order the steps started and ended. */
  const given = new Map<string, Omit<ChatTurnContext, "client" | "signal" | "onCode">>();
  const order: string[] = [];
  /** The runs whose step hangs, as one cut off by its worker's stop does. */
  const hung = new Set<string>();
  const source: Source = { root, head: () => "0000000000000000", commit: () => undefined };
  const chat: AppSteps["chat"] = async (step, input) => {
    const { client: _c, signal, onCode, ...rest } = step;
    given.set(step.runId, rest);
    order.push(`start ${step.runId}`);
    const { chats } = step.client;
    try {
      if (step.resumed) return { interrupted: true };
      const text = input.message.parts[0]!.text;
      if (text === "wait") {
        await new Promise((stopped) => signal.addEventListener("abort", stopped, { once: true }));
        await chats.append(input.chat, step.runId, [{ type: "text-delta", id: "t", delta: "stopped" }]);
      } else if (text === "code") {
        const code = await new Promise<string>((pasted) => {
          const forget = onCode((typed) => {
            forget();
            pasted(typed);
          });
        });
        await chats.append(input.chat, step.runId, [{ type: "text-delta", id: "t", delta: `pasted ${code.length}` }]);
      } else if (text === "hang") {
        // Deaf to the worker's stop, and never done: what the stopped worker had of it is gone.
        hung.add(step.runId);
        await new Promise<never>(() => {});
      } else {
        await chats.append(input.chat, step.runId, [
          { type: "start", messageId: `reply-${input.message.id}` },
          { type: "text-delta", id: "t", delta: text },
        ]);
      }
      return { reply: `reply-${input.message.id}` };
    } finally {
      await chats.end(input.chat, step.runId);
      order.push(`end ${step.runId}`);
    }
  };
  const steps: AppSteps = {
    adopt: failing,
    patch: failing,
    goLive: failing,
    goLiveHost: failing,
    connectExisting: failing,
    chat,
  };
  const app = useTestApp(config(), { databaseUrl: freshDatabase("chat_turns"), source, app: steps });
  const open = (id: string, person = "alice") =>
    app.client.chats.open({ id, person, engine: "loop", title: `Chat ${id}` });

  it("is started as its chat's person under the id of the chat and the message, and is no visitor's", async () => {
    await open("rules");
    const input = { chat: "rules", message: said("m1", "Hi") };
    const runId = chatRunId("rules", "m1");
    for (const runIdGiven of [undefined, "chat:rules:m2", "chat:other:m1"]) {
      const err = await failure(app.client.start(CHAT_WORKFLOW, input, { startedBy: "alice", runId: runIdGiven }));
      expect(errorCode(err), runIdGiven).toBe("invalid_input");
    }
    const after = await failure(
      app.client.start(CHAT_WORKFLOW, { ...input, after: "chat:other:m0" }, { startedBy: "alice", runId }),
    );
    expect(errorCode(after)).toBe("invalid_input");
    // Bob's start of Alice's chat, and a visitor's.
    expect(errorCode(await failure(app.client.startTurn(input, { startedBy: "bob" })))).toBe("invalid_input");
    const visitor = await failure(app.client.startTurn(input, { startedBy: visitorPrincipal("auth0", "u1") }));
    expect(errorCode(visitor)).toBe("policy_denied");
    expect(await app.client.turn("rules")).toBeUndefined();
  });

  it("runs the turn in a step given the worker's client, repository and config, and the person, and streams what it writes", async () => {
    await open("hello");
    const runId = await app.client.startTurn({ chat: "hello", message: said("m1", "Hello") }, { startedBy: "alice" });
    expect(runId).toBe("chat:hello:m1");
    expect(await app.client.result(runId)).toEqual({ reply: "reply-m1" });
    expect(given.get(runId)).toMatchObject({ source, by: { id: "alice" }, runId, resumed: false });
    expect(await app.client.chats.chunks(runId, 0)).toEqual({
      chunks: [
        { type: "start", messageId: "reply-m1" },
        { type: "text-delta", id: "t", delta: "Hello" },
      ],
      last: 3,
      ended: true,
    });
    expect(await app.client.chats.chunks(runId, 2)).toEqual({ chunks: [], last: 3, ended: true });
    expect(await app.client.turn("hello")).toMatchObject({ runId, status: "finished" });
  });

  it("stops the turn under way for a new message, which waits for it to end; its chunks go when the next begins", async () => {
    await open("stops");
    const first = await app.client.startTurn({ chat: "stops", message: said("m1", "wait") }, { startedBy: "alice" });
    await waitFor(() => given.has(first));
    expect((await app.client.turn("stops"))?.status).toBe("running");
    const second = await app.client.startTurn({ chat: "stops", message: said("m2", "Next") }, { startedBy: "alice" });
    expect(await app.client.result(first)).toEqual({ reply: "reply-m1" });
    expect(await app.client.result(second)).toEqual({ reply: "reply-m2" });
    expect(order.filter((step) => step.includes("chat:stops:"))).toEqual([
      `start ${first}`,
      `end ${first}`,
      `start ${second}`,
      `end ${second}`,
    ]);
    expect(await app.client.chats.chunks(first, 0)).toEqual({ chunks: [], last: 0, ended: false });
  });

  it("hands a pasted code to the turn's sign-in, sealed, and only the chat's person's to a turn under way", async () => {
    await open("signs");
    const runId = await app.client.startTurn({ chat: "signs", message: said("m1", "code") }, { startedBy: "alice" });
    await waitFor(() => given.has(runId));
    const bob = await failure(app.client.turnCode("signs", "123456", { by: "bob" }));
    expect(errorCode(bob)).toBe("run_not_found");
    await app.client.turnCode("signs", "123456", { by: "alice" });
    await app.client.result(runId);
    expect((await app.client.chats.chunks(runId, 0)).chunks).toEqual([
      { type: "text-delta", id: "t", delta: "pasted 6" },
    ]);
    // The run's messages keep the code sealed, never as it was pasted.
    const told = await app.raw.listWorkflowSteps(runId);
    expect(JSON.stringify(told)).not.toContain("123456");
    const ended = await failure(app.client.turnCode("signs", "123456", { by: "alice" }));
    expect(errorCode(ended)).toBe("run_not_found");
  });

  it("resumes a turn a restart cut short as begun, so its step runs nothing again", async () => {
    await open("restarts");
    const runId = await app.client.startTurn({ chat: "restarts", message: said("m1", "hang") }, { startedBy: "alice" });
    await waitFor(() => hung.has(runId));
    await app.restart();
    expect(await app.client.result(runId)).toEqual({ interrupted: true });
    expect(given.get(runId)).toMatchObject({ resumed: true });
    expect((await app.client.chats.chunks(runId, 0)).ended).toBe(true);
  });
});

describe("a chat turn, on a worker without the app's steps", () => {
  const app = useTestApp(config(), { databaseUrl: freshDatabase("chat_turns_none") });

  it("fails at once, saying where the agent runs", async () => {
    await app.client.chats.open({ id: "away", person: "alice", engine: "loop", title: "Away" });
    const runId = await app.client.startTurn({ chat: "away", message: said("m1", "Hi") }, { startedBy: "alice" });
    await expect(app.client.result(runId)).rejects.toThrow(NO_CHAT_STEPS);
    expect(await app.client.chats.chunks(runId, 0)).toEqual({ chunks: [], last: 0, ended: false });
  });
});
