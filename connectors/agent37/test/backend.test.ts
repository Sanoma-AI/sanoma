import { checkSandbox } from "sanoma/testing/sandbox";
import { RUNNER_PORT, runnerHealth } from "sanoma/workflows";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agent37Api } from "../src/api.ts";
import { agent37Backend, BOX, labelOf } from "../src/backend.ts";
import { DEFAULTS, instance } from "../src/connector.ts";
import { fakeAgent37Vendor, KEY } from "./vendor.ts";

// The backend against Agent37 on this machine (`vendor.ts`): its API from memory, its exec real,
// so the runner the backend writes in and starts, and the commands it runs, are the real ones.

let vendor: Awaited<ReturnType<typeof fakeAgent37Vendor>>;
beforeAll(async () => {
  vendor = await fakeAgent37Vendor();
});
afterAll(() => vendor.close());
beforeEach(() => {
  vi.stubGlobal("fetch", vendor.fetch);
  vendor.sent.length = 0;
  return () => vi.unstubAllGlobals();
});

const secrets = async (names: readonly string[]) => new Map(names.map((name) => [name, KEY]));
const backendOf = (declared: Record<string, unknown> = {}) =>
  agent37Backend({ secrets, declared }, { edge: vendor.edge, budgetMs: 20_000 });
/** Opens the box `name` of the default shape. */
const open = (backend: ReturnType<typeof backendOf>, name: string) =>
  backend.open({ name, image: DEFAULTS.image, size: 2 });
const text = (bytes: Uint8Array | null) => (bytes === null ? null : Buffer.from(bytes).toString());
/** Agent37's API, for what a test does behind the backend's back. */
const api = agent37Api(KEY);
const execs = (id: string) => vendor.sent.filter((s) => s.path === `/instances/${id}/exec`).length;

describe("agent37Backend", () => {
  it("passes the sandbox conformance kit", async () => {
    const results = await checkSandbox({
      backend: backendOf(),
      capabilities: instance.sandbox!.capabilities,
      image: DEFAULTS.image,
      size: 2,
      timeoutMs: 20_000,
    });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results).toHaveLength(8);
  });

  it("makes a box as declared, asleep when idle, its name in its metadata, its label one Agent37 takes", async () => {
    const name = `sanoma-${"c%2Fompany".repeat(6)}-person`;
    const box = await backendOf({ size: 4, memory: 16, disk: 30, region: "us" }).open({
      name,
      image: "my-template",
      size: 4,
    });
    const create = vendor.sent.find((s) => s.method === "POST" && s.path === "/instances");
    expect(create?.body).toEqual({
      template: "my-template",
      resources: { cpu: 4, memory: 16, disk: 30 },
      type: "default",
      region: "us",
      name: labelOf(name),
      metadata: { [BOX]: name },
      auto_sleep: true,
      idle_timeout_seconds: 900,
    });
    expect(labelOf(name)).toHaveLength(60);
    expect(labelOf(name)).toBe(labelOf(name));
    expect(labelOf("sanoma-acme-ada")).toBe("sanoma-acme-ada");
    // It started the runner with exec, and asked the edge for it with the key.
    expect(execs(box.id)).toBeGreaterThan(0);
    expect(new Set(vendor.headersSeen)).toEqual(new Set([KEY]));
    expect(await box.expose(3000)).toEqual({ url: vendor.edge(box.id, 3000), headers: { "X-Agent37-Key": KEY } });
    const ran = await box.run("pwd");
    expect(await new Response(ran.stdout).text()).toBe(`${vendor.home(box.id)}\n`);
    await box.stop();
    expect(vendor.instances.get(box.id)?.status).toBe("sleeping");
    await backendOf().discard({ name });
    expect(vendor.instances.has(box.id)).toBe(false);
  });

  it("wakes a sleeping box, waiting out a checkpoint still being written, its runner still running", async () => {
    const backend = backendOf();
    const box = await open(backend, "sanoma-wake");
    await box.write("kept", new TextEncoder().encode("yes"));
    await box.stop();
    vendor.answer("POST", `/instances/${box.id}/start`, 409, {
      error: { code: "try_again", message: "checkpointing" },
    });
    vendor.sent.length = 0;
    const again = await open(backend, "sanoma-wake");
    expect(again.id).toBe(box.id);
    expect(text(await again.read("kept"))).toBe("yes");
    expect(vendor.sent.filter((s) => s.path === `/instances/${box.id}/start`)).toHaveLength(2);
    expect(vendor.sent.some((s) => s.method === "POST" && s.path === "/instances")).toBe(false);
    expect(execs(box.id)).toBe(0);
    await again.stop();
    await backend.discard({ name: "sanoma-wake" });
  });

  it("stops a box whose sleep is refused, starts its runner again after the fresh boot, and fails at once on a refusal a wait does not change", async () => {
    const backend = backendOf();
    const box = await open(backend, "sanoma-stop");
    vendor.answer("POST", `/instances/${box.id}/sleep`, 502, { error: { code: "provisioning_failed" } });
    await box.stop();
    expect(vendor.instances.get(box.id)?.status).toBe("stopped");
    vendor.sent.length = 0;
    const again = await open(backend, "sanoma-stop");
    expect(execs(box.id)).toBeGreaterThan(0);
    const ran = await again.run("echo back");
    expect(await new Response(ran.stdout).text()).toBe("back\n");
    await again.stop();
    vendor.instances.get(box.id)!.status = "stopped";
    vendor.answer("POST", `/instances/${box.id}/start`, 402, { error: { code: "insufficient_balance" } });
    await expect(open(backend, "sanoma-stop")).rejects.toMatchObject({
      vendorCode: "insufficient_balance",
      status: 402,
    });
    await backend.discard({ name: "sanoma-stop" });
  });

  it("leaves a box asleep when it slept on its own before the stop", async () => {
    const backend = backendOf();
    const box = await open(backend, "sanoma-slept");
    vendor.instances.get(box.id)!.status = "sleeping";
    vendor.answer("POST", `/instances/${box.id}/sleep`, 400, { error: { code: "invalid_request" } });
    await box.stop();
    expect(vendor.instances.get(box.id)?.status).toBe("sleeping");
    await backend.discard({ name: "sanoma-slept" });
  });

  it("kills the commands still running when it stops", async () => {
    const backend = backendOf();
    const box = await open(backend, "sanoma-end");
    const left = await box.run("sleep 4243");
    await box.stop();
    expect((await left.wait()).exitCode).not.toBe(0);
    const again = await open(backend, "sanoma-end");
    const found = await again.run("pgrep -fx 'sleep 4243' || true");
    expect(await new Response(found.stdout).text()).toBe("");
    await again.stop();
    await backend.discard({ name: "sanoma-end" });
  });

  it("fails an open whose runner does not start, with what exec said", async () => {
    const backend = backendOf();
    const box = await open(backend, "sanoma-broken");
    await box.stop();
    await api.stop(box.id);
    vendor.answer("POST", `/instances/${box.id}/exec`, 200, {
      exit_code: 127,
      stdout: "",
      stderr: "node: not found\n",
    });
    await expect(open(backend, "sanoma-broken")).rejects.toThrow(
      `agent37: starting the runner in ${box.id} failed (exit 127): node: not found`,
    );
    await backend.discard({ name: "sanoma-broken" });
  });

  it("replaces a runner of another release that a box kept asleep", async () => {
    const backend = backendOf();
    const box = await open(backend, "sanoma-old");
    await box.stop();
    // Another release's runner, in its place: it answers another protocol.
    await api.stop(box.id);
    await api.start(box.id);
    const old = `require("node:http").createServer((q, s) => s.end(JSON.stringify({ protocol: 0, pid: process.pid }))).listen(process.env.SANOMA_RUNNER_PORT, "127.0.0.1")`;
    await api.exec(box.id, `cd && { nohup node -e '${old}' >/dev/null 2>&1 </dev/null & }`);
    const health = () => runnerHealth(vendor.edge(box.id, RUNNER_PORT), { "X-Agent37-Key": KEY });
    await expect.poll(health).toMatchObject({ protocol: 0 });
    vendor.sent.length = 0;
    const again = await open(backend, "sanoma-old");
    expect(execs(box.id)).toBeGreaterThan(0);
    const ran = await again.run("echo new");
    expect(await new Response(ran.stdout).text()).toBe("new\n");
    await again.stop();
    await backend.discard({ name: "sanoma-old" });
  });

  it("refuses a shape Agent37 has not, and opens nothing without its key", async () => {
    await expect(backendOf({ size: 2, memory: 8 }).open({ name: "x", image: "", size: 2 })).rejects.toThrow(
      "Agent37's shapes",
    );
    await expect(backendOf({ region: "eu" }).open({ name: "x", image: "", size: 2 })).rejects.toThrow(
      "only `us` runs the `default` type",
    );
    const keyless = agent37Backend({ secrets: async () => new Map(), declared: {} });
    await expect(keyless.open({ name: "x", image: "", size: 2 })).rejects.toThrow("AGENT37_API_KEY is not set");
  });
});
