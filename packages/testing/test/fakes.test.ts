import { describe, expect, it } from "vitest";
import { type CallContext, DriverError, memorySecrets } from "@sanoma-ai/workflows";
import { fakeBluesky } from "@sanoma-ai/connector-bluesky/fake";
import { fakeGhost } from "@sanoma-ai/connector-ghost/fake";
import { fakeGithub } from "@sanoma-ai/connector-github/fake";
import { fakeResend } from "@sanoma-ai/connector-resend/fake";
import { fakeStripe } from "@sanoma-ai/connector-stripe/fake";
import type { FakeCall } from "../src/index.ts";
import { connectionFakes } from "@sanoma-ai/workflows/fake";

// No database: the fakes are called the way the runtime calls a driver.
const call = (idempotencyKey: string, attempt = 1): CallContext => ({
  idempotencyKey,
  runId: idempotencyKey.split(":")[0] ?? "run",
  opId: "unused",
  attempt,
  secrets: memorySecrets(),
});
const draft = { title: "Hello world", html: "<p>Hi</p>", status: "draft" as const };

describe("fakes", () => {
  it("refuses a named factory that would share one fake between accounts", () => {
    const shared = fakeGhost();
    const fakes = connectionFakes(() => shared);
    fakes.account({ vendor: "ghost", $connection: "ghost/support" });
    expect(() => fakes.account({ vendor: "ghost", $connection: "ghost/sales" })).toThrow("separate state");
  });
  it("isolates named accounts' state, faults and replies even when idempotency keys overlap", async () => {
    const fakes = connectionFakes(fakeGhost);
    const support = { vendor: "ghost", $connection: "ghost/support" };
    const sales = { vendor: "ghost", $connection: "ghost/sales" };
    const context = (ref: typeof support, id = "shared", account = ref.$connection): CallContext => ({
      ...call(id),
      connection: {
        id: ref.$connection,
        vendor: ref.vendor,
        method: "key",
        account,
        scopes: [],
        revision: "one",
        definition: "test",
      },
    });
    const release = fakes.account(support).hold("ghost.post.create");
    const held = fakes.driver.ops["post.create"]!({ ...draft, title: "Support" }, context(support));
    try {
      const other = await fakes.driver.ops["post.create"]!({ ...draft, title: "Sales" }, context(sales));
      expect(other).toMatchObject({ id: "post_0001", slug: "sales" });
      expect(Object.values(fakes.account(support).state.posts)).toEqual([]);
      release();
      expect(await held).toMatchObject({ id: "post_0001", slug: "support" });
      expect(await fakes.driver.ops["post.create"]!(draft, context(sales))).toEqual(other);
      expect(Object.values(fakes.account(support).state.posts).map((p) => p.title)).toEqual(["Support"]);
      expect(Object.values(fakes.account(sales).state.posts).map((p) => p.title)).toEqual(["Sales"]);
      fakes.account(support).failNext("ghost.post.create");
      await expect(fakes.driver.ops["post.create"]!(draft, context(support, "next"))).rejects.toThrow("failed");
      await expect(fakes.driver.ops["post.create"]!(draft, context(sales, "next"))).resolves.toMatchObject({
        id: "post_0002",
      });
      expect(fakes.calls.map((c) => c.connection)).toEqual([
        support.$connection,
        sales.$connection,
        sales.$connection,
        support.$connection,
        sales.$connection,
      ]);
      // Rebinding keeps the reference but changes the actual vendor account: it gets fresh state.
      await fakes.driver.ops["post.create"]!(
        { ...draft, title: "Replacement" },
        context(support, "shared", "replacement"),
      );
      expect(Object.values(fakes.account(support).state.posts).map((p) => p.title)).toEqual(["Replacement"]);
      await expect(fakes.driver.ops["post.create"]!(draft, call("unnamed"))).rejects.toThrow("named connection");
    } finally {
      release();
      await held;
    }
  });
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

  it("update the state as someone at the vendor would", async () => {
    const ghost = fakeGhost();
    const post = (await ghost.driver.ops["post.create"]!(draft, call("r:0"))) as { id: string };
    ghost.update((state) => {
      state.posts[post.id]!.title = "Edited at Ghost";
    });
    expect(ghost.state.posts[post.id]?.title).toBe("Edited at Ghost");
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

  it("compose: three vendors on one log, each keeping its own state", async () => {
    const calls: FakeCall[] = [];
    const ghost = fakeGhost({ calls });
    const resend = fakeResend({ calls });
    const bluesky = fakeBluesky({ calls });
    await ghost.driver.ops["post.create"]!(draft, call("r:0"));
    await resend.driver.ops["broadcast.create"]!({ audience: "news", subject: "Hi", html: "" }, call("r:1"));
    await bluesky.driver.ops["post.create"]!({ text: "x" }, call("r:2"));
    expect(calls.map((c) => c.op)).toEqual(["ghost.post.create", "resend.broadcast.create", "bluesky.post.create"]);
    expect(Object.values(ghost.state.posts)).toHaveLength(1);
    expect(Object.values(resend.state.broadcasts)).toHaveLength(1);
    expect(bluesky.state.posts.map((p) => p.text)).toEqual(["x"]);
    for (const fake of [ghost, resend, bluesky]) fake.reset();
    expect(calls).toEqual([]);
    expect(bluesky.state.posts).toEqual([]);
  });

  it("resource fakes: an override shows on the next read", async () => {
    const github = fakeGithub();
    const imported = await github.driver.ops["repository.import"]!({ id: "sanoma" }, call("r:0"));
    // A test that drifts the vendor while a worker reads it.
    github.override("repository", "sanoma", { has_wiki: false });
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
