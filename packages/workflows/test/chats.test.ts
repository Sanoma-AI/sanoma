import { testDatabaseUrl } from "@sanoma-ai/testing";
import type { UIMessage } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorCode, SanomaClient } from "../src/index.ts";
import { appRoot } from "./tree.ts";

// The operator agent's chats through `SanomaClient.chats`, on Postgres: a chat opened, its draft
// attached, its messages written as a turn writes them (the person's, then the reply's snapshots
// in place) and read back in order, and the person's list.

let client: SanomaClient;
beforeAll(async () => {
  client = await SanomaClient.connect({
    workflows: [],
    connectors: [],
    root: appRoot("chats"),
    databaseUrl: testDatabaseUrl("chats"),
  });
});
afterAll(() => client?.close());

const text = (id: string, role: UIMessage["role"], said: string): UIMessage => ({
  id,
  role,
  parts: [{ type: "text", text: said }],
});

describe("chats", () => {
  it("opens a chat, attaches its draft, keeps its messages in order, gets it, and lists the person's chats newest first", async () => {
    const person = `ada-${Date.now()}`;
    const first = await client.chats.open({ person, engine: "loop", title: "Add a laptop step" });
    const second = await client.chats.open({ person, engine: "loop", title: "Rename a step", id: `browser-${person}` });
    expect(second).toBe(`browser-${person}`);
    await expect(client.chats.open({ person, engine: "loop", title: "Again", id: second })).rejects.toSatisfy(
      (err) => errorCode(err) === "invalid_input",
    );
    await client.chats.attach(first, first);

    // The person's message, then the reply as it streams: its snapshot written in place each time.
    await client.chats.upsert(first, [text("u1", "user", "add a laptop step to offboarding")]);
    await client.chats.upsert(first, [text("a1", "assistant", "Reading")]);
    await client.chats.upsert(first, [text("a1", "assistant", "Done: the draft has it.")]);
    await client.chats.upsert(first, [text("u2", "user", "continue"), text("a2", "assistant", "Nothing left.")]);
    expect(await client.chats.load(first)).toEqual([
      text("u1", "user", "add a laptop step to offboarding"),
      text("a1", "assistant", "Done: the draft has it."),
      text("u2", "user", "continue"),
      text("a2", "assistant", "Nothing left."),
    ]);
    expect(await client.chats.load(second)).toEqual([]);
    await expect(client.chats.upsert(first, [{ ...text("", "user", "no id") }])).rejects.toThrow("needs an id");

    const listed = await client.chats.list(person);
    expect(listed.map((c) => c.id)).toEqual([second, first]);
    expect(listed[1]).toEqual({
      id: first,
      person,
      engine: "loop",
      draftId: first,
      title: "Add a laptop step",
      createdAt: expect.any(Number),
    });
    expect(listed[0]).not.toHaveProperty("draftId");
    expect(await client.chats.get(first)).toEqual(listed[1]);
    expect(await client.chats.get(`${person}-none`)).toBeUndefined();
    expect(await client.chats.list(`${person}-nobody`)).toEqual([]);
  });
});
