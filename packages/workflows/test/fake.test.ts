import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
import { afterAll, describe, expect, it } from "vitest";
import type { FakeCall } from "../src/fake.ts";
import type { CallContext } from "../src/op.ts";

const call = (idempotencyKey: string): CallContext => ({ idempotencyKey, runId: "r", opId: "unused", attempt: 1 });
const draft = { title: "Hello", html: "<p>Hi</p>", status: "draft" as const };
const dir = mkdtempSync(join(tmpdir(), "sanoma-fake-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Fake.fresh", () => {
  it("is a new in-memory fake: its own state and calls, the parent's faults left behind, and no file", async () => {
    const file = join(dir, "ghost.json");
    const log: FakeCall[] = [];
    const parent = fakeGhost({ file, calls: log });
    parent.failNext("ghost.post.create");
    const fresh = parent.fresh();

    expect(await fresh.driver.ops["post.create"]!(draft, call("k"))).toMatchObject({ id: "post_0001" });
    expect(fresh.state.posts).toHaveProperty("post_0001");
    expect(fresh.calls.map((c) => c.op)).toEqual(["ghost.post.create"]);
    expect(existsSync(file)).toBe(false);
    expect(parent.state.posts).toEqual({});
    expect(log).toEqual([]);

    // The parent's fault is still its own, and what it does is not the fresh one's.
    await expect(parent.driver.ops["post.create"]!(draft, call("k"))).rejects.toThrow("failed");
    expect(await parent.driver.ops["post.create"]!(draft, call("k"))).toMatchObject({ id: "post_0001" });
    expect(existsSync(file)).toBe(true);
    expect(log).toHaveLength(2);
    expect(fresh.calls).toHaveLength(1);
    expect(Object.keys(fresh.state.posts)).toEqual(["post_0001"]);
  });
});
