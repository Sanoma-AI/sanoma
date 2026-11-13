import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type CallContext,
  DriverError,
  memorySecrets,
  RUNNER_PORT,
  RUNNER_PROTOCOL,
  runnerBox,
  runnerHealth,
} from "sanoma/workflows";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BOX, GROUP } from "../src/backend.ts";
import { agent37Ops } from "../src/connector.ts";
import { agent37Driver } from "../src/driver.ts";
import { fakeAgent37 } from "../src/fake.ts";
import { fakeAgent37Vendor, KEY } from "./vendor.ts";

// The box operations, which Sanoma's control plane calls with the key, against Agent37 on this
// machine (`vendor.ts`): the runner they start is the real one, reached over the signed link they
// hand back with no key, as a company's own instance reaches it.

let vendor: Awaited<ReturnType<typeof fakeAgent37Vendor>>;
beforeAll(async () => {
  vendor = await fakeAgent37Vendor();
});
afterAll(() => vendor.close());
beforeEach(() => {
  vi.stubGlobal("fetch", vendor.fetch);
  vi.stubEnv("AGENT37_API_KEY", KEY);
  vendor.sent.length = 0;
  return () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  };
});

let calls = 0;
const call = (
  op: string,
  input: Record<string, unknown>,
  ops = agent37Driver({ edge: vendor.edge, budgetMs: 20_000 }).ops,
) => {
  const key = `run-1:${++calls}`;
  return ops[op]!(input, {
    idempotencyKey: key,
    runId: "run-1",
    opId: `agent37.${op}`,
    attempt: 1,
    secrets: memorySecrets(),
  } satisfies CallContext) as Promise<any>;
};
const creates = () => vendor.sent.filter((s) => s.method === "POST" && s.path === "/instances");
const execs = (id: string) => vendor.sent.filter((s) => s.path === `/instances/${id}/exec`);
/** A request to the edge with neither the key nor a link's token. */
const bare = (url: string) => fetch(url).then((res) => res.status);

describe("box operations", () => {
  it("opens a box, made labelled with its group and then reused, its link reaching the runner with no key and only its port", async () => {
    const opened = await call("box.open", { name: "sanoma-acme", group: "acme", ttl: 600 });
    expect(creates().map((s) => s.body?.metadata)).toEqual([{ [BOX]: "sanoma-acme", [GROUP]: "acme" }]);
    expect(creates()[0]!.body).not.toHaveProperty("network");
    expect(opened.protocol).toBe(RUNNER_PROTOCOL);
    expect(Date.parse(opened.expiresAt) - Date.now()).toBeGreaterThan(590_000);
    const link = new URL(opened.url);
    expect(link.origin).toBe(new URL(vendor.edge(opened.id, RUNNER_PORT)).origin);
    expect(link.searchParams.get("a37_token")).toMatch(/^[0-9a-f]{32}$/);

    // The link is the only credential: the runner answers over it, and over nothing less.
    expect(await runnerHealth(opened.url)).toMatchObject({ protocol: RUNNER_PROTOCOL });
    expect(await bare(`${vendor.edge(opened.id, RUNNER_PORT)}/runner/health`)).toBe(401);
    const elsewhere = new URL(opened.url);
    elsewhere.port = new URL(vendor.edge(opened.id, 3000)).port;
    expect(await bare(elsewhere.href)).toBe(401);
    const { run, stop } = runnerBox({ url: opened.url, id: opened.id });
    const ran = await run("echo over the link");
    expect(await new Response(ran.stdout).text()).toBe("over the link\n");
    await stop();

    // Opened again: the same box, its runner running, pnpm put in with the API's exec.
    vendor.sent.length = 0;
    const again = await call("box.open", { name: "sanoma-acme", group: "acme", ttl: 60 });
    expect(again.id).toBe(opened.id);
    expect(again.url).not.toBe(opened.url);
    expect(creates()).toEqual([]);
    expect(execs(opened.id).map((s) => String(s.body?.command))).toEqual([expect.stringContaining("corepack")]);
    await call("box.discard", { name: "sanoma-acme" });
  });

  it("makes a new box with the network it is given", async () => {
    await call("box.open", { name: "sanoma-shut", group: "shut", network: ["registry.npmjs.org"], ttl: 60 });
    expect(creates()[0]!.body?.network).toEqual({ allow: ["registry.npmjs.org"] });
    await call("box.discard", { group: "shut" });
  });

  it("exposes another port of a box over a link of its own, which stops working when it expires", async () => {
    const server = createServer((_, res) => res.end("served")).listen(0, "127.0.0.1");
    await new Promise((done) => server.once("listening", done));
    const { port } = server.address() as AddressInfo;
    try {
      const opened = await call("box.open", { name: "sanoma-port", group: "port", ttl: 60 });
      const exposed = await call("box.expose", { name: "sanoma-port", port, ttl: 60 });
      expect(new URL(exposed.url).origin).toBe(new URL(vendor.edge(opened.id, port)).origin);
      expect(await (await fetch(exposed.url)).text()).toBe("served");
      vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(exposed.expiresAt) });
      expect(await bare(exposed.url)).toBe(401);
      vi.useRealTimers();
      await expect(call("box.expose", { name: "sanoma-none", port, ttl: 60 })).rejects.toMatchObject({
        status: 404,
        vendorCode: "not_found",
        retryable: false,
      });
      await call("box.discard", { name: "sanoma-port" });
    } finally {
      vi.useRealTimers();
      server.close();
    }
  });

  it("puts a box to sleep, lists a group's boxes, and discards one by name or a group's, never another group's", async () => {
    const one = await call("box.open", { name: "sanoma-a-one", group: "a", ttl: 60 });
    const two = await call("box.open", { name: "sanoma-a-two", group: "a", ttl: 60 });
    const other = await call("box.open", { name: "sanoma-b-one", group: "b", ttl: 60 });
    expect(await call("box.sleep", { name: "sanoma-a-one" })).toEqual({ ids: [one.id] });
    expect(vendor.instances.get(one.id)?.status).toBe("sleeping");
    expect(await call("box.sleep", { name: "sanoma-none" })).toEqual({ ids: [] });
    const listed = await call("box.list", { group: "a" });
    expect(listed.boxes).toHaveLength(2);
    expect(listed.boxes).toEqual(
      expect.arrayContaining([
        { id: one.id, name: "sanoma-a-one", awake: false },
        { id: two.id, name: "sanoma-a-two", awake: true },
      ]),
    );

    expect(await call("box.discard", { name: "sanoma-a-two" })).toEqual({ ids: [two.id] });
    expect(vendor.instances.has(two.id)).toBe(false);
    expect(await call("box.discard", { group: "a" })).toEqual({ ids: [one.id] });
    expect(await call("box.discard", { group: "a" })).toEqual({ ids: [] });
    expect([...vendor.instances.keys()]).toEqual([other.id]);
    expect((await call("box.list", { group: "b" })).boxes).toEqual([
      { id: other.id, name: "sanoma-b-one", awake: true },
    ]);
    await call("box.discard", { group: "b" });
  });

  it("fails an open past the workspace's limit of awake instances with Agent37's code, not to be retried", async () => {
    vendor.answer("POST", "/instances", 409, {
      error: { code: "instance_limit_reached", message: "the workspace runs as many instances as its limit allows" },
    });
    const failed = await call("box.open", { name: "sanoma-full", group: "full", ttl: 60 }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(DriverError);
    expect(failed).toMatchObject({ status: 409, vendorCode: "instance_limit_reached", retryable: false });
    expect(vendor.instances.size).toBe(0);
  });

  it("takes a box's name or a group to discard, not both, and keeps its links out of the ledger", () => {
    const { discard, open, expose } = agent37Ops.box;
    expect(discard.input.safeParse({ name: "x" }).success).toBe(true);
    expect(discard.input.safeParse({ group: "x" }).success).toBe(true);
    expect(discard.input.safeParse({ name: "x", group: "x" }).success).toBe(false);
    expect(discard.input.safeParse({}).success).toBe(false);
    expect(open.opaque).toEqual(["url"]);
    expect(expose.opaque).toEqual(["url"]);
    expect(open.input.safeParse({ name: "x", group: "x", ttl: 59 }).success).toBe(false);
  });
});

describe("fakeAgent37's boxes", () => {
  it("opens, exposes, sleeps, lists and discards boxes in memory, recording each call", async () => {
    const fake = fakeAgent37();
    const ops = fake.driver.ops;
    const opened = await call("box.open", { name: "sanoma-acme", group: "acme", ttl: 60 }, ops);
    expect(opened).toMatchObject({ id: expect.stringMatching(/^[0-9a-f]{10}$/), protocol: RUNNER_PROTOCOL });
    expect(opened.url).toContain(`${opened.id}-${RUNNER_PORT}.agent37.app/?a37_token=`);
    expect((await call("box.open", { name: "sanoma-acme", group: "acme", ttl: 60 }, ops)).id).toBe(opened.id);
    expect((await call("box.expose", { name: "sanoma-acme", port: 3000, ttl: 60 }, ops)).url).toContain(
      `${opened.id}-3000.agent37.app`,
    );
    await expect(call("box.expose", { name: "sanoma-none", port: 3000, ttl: 60 }, ops)).rejects.toMatchObject({
      vendorCode: "not_found",
    });
    await call("box.open", { name: "sanoma-other", group: "other", ttl: 60 }, ops);
    expect(await call("box.sleep", { name: "sanoma-acme" }, ops)).toEqual({ ids: [opened.id] });
    expect(await call("box.list", { group: "acme" }, ops)).toEqual({
      boxes: [{ id: opened.id, name: "sanoma-acme", awake: false }],
    });
    expect(await call("box.discard", { group: "acme" }, ops)).toEqual({ ids: [opened.id] });
    expect(fake.state.boxes.map((box) => box.name)).toEqual(["sanoma-other"]);
    expect(fake.calls.map((c) => c.op)).toEqual([
      "agent37.box.open",
      "agent37.box.open",
      "agent37.box.expose",
      "agent37.box.expose",
      "agent37.box.open",
      "agent37.box.sleep",
      "agent37.box.list",
      "agent37.box.discard",
    ]);
  });
});
