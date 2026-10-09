import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type CallContext, DriverError } from "@sanoma/workflows";
import { type FakeCall, fakeBluesky, fakeGhost, fakeGithub, fakeResend, fakeStripe } from "../src/index.ts";

// No database: the fakes are called the way the runtime calls a driver.
const call = (idempotencyKey: string, attempt = 1): CallContext => ({
  idempotencyKey,
  runId: idempotencyKey.split(":")[0] ?? "run",
  opId: "unused",
  attempt,
});
const draft = { title: "Hello world", html: "<p>Hi</p>", status: "draft" as const };
const dir = mkdtempSync(join(tmpdir(), "sanoma-fakes-"));
const vendorFile = (vendor: string) => join(dir, `vendors.${vendor}.json`);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("fakes", () => {
  it("keep the fields the connector declares", async () => {
    const resend = fakeResend();
    const { id } = (await resend.driver.ops["broadcast.create"]!(
      { audience: "news", from: "hi@example.test", subject: "Hi", html: "<p>Hi</p>" },
      call("r:0"),
    )) as { id: string };
    expect(resend.state.broadcasts[id]).toMatchObject({ from: "hi@example.test", status: "draft" });
    const ghost = fakeGhost();
    expect(await ghost.driver.ops["post.create"]!(draft, call("r:0"))).toMatchObject({ status: "draft" });
  });

  it("return the first reply for a repeated idempotency key and change nothing", async () => {
    const bluesky = fakeBluesky();
    const create = bluesky.driver.ops["post.create"]!;
    const first = await create({ text: "one" }, call("r:0"));
    expect(await create({ text: "one" }, call("r:0", 2))).toEqual(first);
    expect(bluesky.state.posts).toHaveLength(1);
    await create({ text: "two" }, call("r:1"));
    expect(bluesky.state.posts.map((p) => p.text)).toEqual(["one", "two"]);
    expect(bluesky.calls.map((c) => [c.idempotencyKey, c.attempt])).toEqual([
      ["r:0", 1],
      ["r:0", 2],
      ["r:1", 1],
    ]);
  });

  it("fail the next call on failNext, with a retryable DriverError unless told otherwise", async () => {
    const ghost = fakeGhost();
    const create = ghost.driver.ops["post.create"]!;
    ghost.failNext("ghost.post.create");
    const err = await create(draft, call("r:0")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(err).toMatchObject({ code: "driver_failed", retryable: true });
    expect(ghost.state.posts).toEqual({});

    ghost.failNext("ghost.post.create", new Error("boom"));
    await expect(create(draft, call("r:0"))).rejects.toThrow("boom");
    await create(draft, call("r:0"));
    expect(Object.keys(ghost.state.posts)).toHaveLength(1);
    expect(() => ghost.failNext("ghost.post.delete" as "ghost.post.create")).toThrow(
      "fake ghost: no operation ghost.post.delete",
    );
  });

  it("take effect and then throw on loseReply, so a retry with the same key gets the reply and no second effect", async () => {
    const resend = fakeResend();
    const create = resend.driver.ops["broadcast.create"]!;
    const send = resend.driver.ops["broadcast.send"]!;
    const { id } = (await create({ audience: "news", subject: "Hi", html: "" }, call("r:0"))) as { id: string };

    resend.loseReply("resend.broadcast.send");
    await expect(send({ id }, call("r:1"))).rejects.toMatchObject({ retryable: true });
    expect(resend.state.broadcasts[id]?.status).toBe("sent");
    // Without the key, the vendor refuses a second send.
    expect(await send({ id }, call("r:1", 2))).toEqual({ id, status: "queued" });
    await expect(send({ id }, call("r:2"))).rejects.toMatchObject({ status: 422, retryable: false });
  });

  it("throw a 429 on rateLimit and change nothing", async () => {
    const bluesky = fakeBluesky();
    bluesky.rateLimit("bluesky.post.create");
    await expect(bluesky.driver.ops["post.create"]!({ text: "x" }, call("r:0"))).rejects.toMatchObject({
      code: "driver_failed",
      status: 429,
      retryable: true,
    });
    expect(bluesky.state.posts).toEqual([]);
  });

  it("hold the next call until released, then dedupe a call that overtook it with the same key", async () => {
    const bluesky = fakeBluesky();
    const create = bluesky.driver.ops["post.create"]!;
    const release = bluesky.hold("bluesky.post.create");
    let settled = false;
    const held = create({ text: "held" }, call("r:0")).finally(() => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(bluesky.state.posts).toEqual([]);

    // A second worker makes the same call while the first is stuck.
    const overtaking = await create({ text: "held" }, call("r:0"));
    release();
    expect(await held).toEqual(overtaking);
    expect(bluesky.state.posts).toHaveLength(1);
  });

  it("keep state and replies in a file, across instances", async () => {
    const file = join(dir, "ghost.json");
    const one = fakeGhost({ file });
    const post = (await one.driver.ops["post.create"]!(draft, call("r:0"))) as { id: string };
    await one.driver.ops["post.publish"]!({ id: post.id }, call("r:1"));

    const two = fakeGhost({ file });
    expect(two.state.posts[post.id]).toMatchObject({ title: "Hello world", status: "published" });
    expect(await two.driver.ops["post.create"]!(draft, call("r:0"))).toEqual(post);
    expect(Object.keys(two.state.posts)).toHaveLength(1);
    // Each instance sees the other's writes.
    await two.driver.ops["post.create"]!({ ...draft, title: "Second" }, call("r:2"));
    expect(Object.keys(one.state.posts)).toHaveLength(2);

    two.reset();
    expect(one.state.posts).toEqual({});
  });

  it("update the state as someone at the vendor would, in the file another instance reads", async () => {
    const file = join(dir, "ghost-update.json");
    const one = fakeGhost({ file });
    const post = (await one.driver.ops["post.create"]!(draft, call("r:0"))) as { id: string };
    fakeGhost({ file }).update((state) => {
      state.posts[post.id]!.title = "Edited at Ghost";
    });
    expect(one.state.posts[post.id]?.title).toBe("Edited at Ghost");
  });

  it("log into one shared list, and reset drops only their own calls", async () => {
    const calls: FakeCall[] = [];
    const ghost = fakeGhost({ calls });
    const bluesky = fakeBluesky({ calls });
    await ghost.driver.ops["post.create"]!(draft, call("r:0"));
    await bluesky.driver.ops["post.create"]!({ text: "x" }, call("r:1"));
    await ghost.driver.ops["post.create"]!(draft, call("r:2"));
    expect(calls.map((c) => c.op)).toEqual(["ghost.post.create", "bluesky.post.create", "ghost.post.create"]);
    ghost.reset();
    expect(calls.map((c) => c.op)).toEqual(["bluesky.post.create"]);
  });

  it("compose: three vendors on one log, each keeping its own file", async () => {
    const calls: FakeCall[] = [];
    const ghost = fakeGhost({ calls, file: vendorFile("ghost") });
    const resend = fakeResend({ calls, file: vendorFile("resend") });
    const bluesky = fakeBluesky({ calls, file: vendorFile("bluesky") });
    await ghost.driver.ops["post.create"]!(draft, call("r:0"));
    await resend.driver.ops["broadcast.create"]!({ audience: "news", subject: "Hi", html: "" }, call("r:1"));
    await bluesky.driver.ops["post.create"]!({ text: "x" }, call("r:2"));
    expect(calls.map((c) => c.op)).toEqual(["ghost.post.create", "resend.broadcast.create", "bluesky.post.create"]);
    expect(Object.values(fakeGhost({ file: vendorFile("ghost") }).state.posts)).toHaveLength(1);
    expect(Object.values(fakeResend({ file: vendorFile("resend") }).state.broadcasts)).toHaveLength(1);
    expect(bluesky.state.posts.map((p) => p.text)).toEqual(["x"]);
    for (const fake of [ghost, resend, bluesky]) fake.reset();
    expect(calls).toEqual([]);
    expect(fakeBluesky({ file: vendorFile("bluesky") }).state.posts).toEqual([]);
  });

  it("resource fakes: an override reaches a fake on the same file, and drift shows on the next read", async () => {
    const github = fakeGithub({ file: vendorFile("github") });
    const imported = await github.driver.ops["repository.import"]!({ id: "sanoma" }, call("r:0"));
    // Another process's fake, on the same file: a test that drifts the vendor while a worker reads it.
    fakeGithub({ file: vendorFile("github") }).override("repository", "sanoma", { has_wiki: false });
    const read = (await github.driver.ops["repository.read"]!(imported, call("r:1"))) as {
      state: { has_wiki: boolean };
    };
    expect(read.state.has_wiki).toBe(false);
    const stripe = fakeStripe();
    const product = (await stripe.driver.ops["product.read"]!({ id: "prod_SanomaTest0001" }, call("r:2"))) as {
      state: { name: string };
    };
    expect(product.state.name).toBe("Sanoma test product");
  });
});
