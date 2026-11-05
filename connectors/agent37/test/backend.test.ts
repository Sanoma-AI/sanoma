import { utils } from "ssh2";
import { checkSandbox } from "@sanoma-ai/testing/sandbox";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agent37Backend, BOX, labelOf } from "../src/backend.ts";
import { DEFAULTS, instance } from "../src/connector.ts";
import { sshKey } from "../src/ssh.ts";
import { fakeAgent37Vendor, KEY } from "./vendor.ts";

// The backend against Agent37 on this machine (`vendor.ts`): its API from memory, its SSH server
// behind a local WebSocket, so the tunnel, the SSH session and the commands are the real ones.

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
const text = (bytes: Uint8Array | null) => (bytes === null ? null : Buffer.from(bytes).toString());

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
    // It registered its key, and the tunnel carried the API key.
    expect(vendor.keys.map((k) => k.getPublicSSH().toString("base64"))).toEqual([sshKey(KEY).publicKey.split(" ")[1]]);
    expect(vendor.headersSeen.at(-1)).toBe(KEY);
    await box.stop();
    expect(vendor.instances.get(box.id)?.status).toBe("sleeping");
    await backendOf().discard({ name });
    expect(vendor.instances.has(box.id)).toBe(false);
  });

  it("runs a command in its cwd with its env, in a process group a kill ends whole", async () => {
    const backend = backendOf();
    const box = await backend.open({ name: "sanoma-env", image: DEFAULTS.image, size: 2 });
    try {
      await box.write("work/it's here/x.txt", new TextEncoder().encode("hi"));
      const ran = await box.run('pwd; cat x.txt; echo " $GREETING"', {
        cwd: "work/it's here",
        env: { GREETING: "it's 'quoted'" },
      });
      const [out, { exitCode }] = await Promise.all([new Response(ran.stdout).text(), ran.wait()]);
      expect(exitCode).toBe(0);
      expect(out).toBe(`${vendor.home(box.id)}/work/it's here\nhi it's 'quoted'\n`);
      // A child of the command dies with it.
      const tree = await box.run("sleep 4241 & sleep 4241; wait");
      tree.kill("SIGTERM");
      expect((await tree.wait()).exitCode).toBe(143);
      const left = await box.run("pgrep -fx 'sleep 4241' || true");
      expect(await new Response(left.stdout).text()).toBe("");
      // An abort kills it too.
      const aborting = new AbortController();
      const aborted = await box.run("sleep 30", { signal: aborting.signal });
      aborting.abort();
      expect((await aborted.wait()).exitCode).toBe(137);
      await expect(box.run("true", { env: { "NO-NAME": "x" } })).rejects.toThrow("NO-NAME is no environment");
      expect(await box.read("nothing/here")).toBeNull();
      await expect(box.read("work")).rejects.toThrow("work could not be read");
      expect((await box.expose(3000)).headers).toEqual({ "X-Agent37-Key": KEY });
    } finally {
      await box.stop();
      await backend.discard({ name: "sanoma-env" });
    }
  });

  it("wakes a sleeping box, waiting out a checkpoint still being written", async () => {
    const backend = backendOf();
    const box = await backend.open({ name: "sanoma-wake", image: DEFAULTS.image, size: 2 });
    await box.write("kept", new TextEncoder().encode("yes"));
    await box.stop();
    vendor.answer("POST", `/instances/${box.id}/start`, 409, {
      error: { code: "try_again", message: "checkpointing" },
    });
    vendor.sent.length = 0;
    const again = await backend.open({ name: "sanoma-wake", image: DEFAULTS.image, size: 2 });
    expect(again.id).toBe(box.id);
    expect(text(await again.read("kept"))).toBe("yes");
    expect(vendor.sent.filter((s) => s.path === `/instances/${box.id}/start`)).toHaveLength(2);
    expect(vendor.sent.some((s) => s.method === "POST" && s.path === "/instances")).toBe(false);
    await again.stop();
    await backend.discard({ name: "sanoma-wake" });
  });

  it("stops a box whose sleep is refused, and fails at once on a refusal a wait does not change", async () => {
    const backend = backendOf();
    const box = await backend.open({ name: "sanoma-stop", image: DEFAULTS.image, size: 2 });
    vendor.answer("POST", `/instances/${box.id}/sleep`, 502, { error: { code: "provisioning_failed" } });
    await box.stop();
    expect(vendor.instances.get(box.id)?.status).toBe("stopped");
    vendor.answer("POST", `/instances/${box.id}/start`, 402, { error: { code: "insufficient_balance" } });
    await expect(backend.open({ name: "sanoma-stop", image: DEFAULTS.image, size: 2 })).rejects.toMatchObject({
      vendorCode: "insufficient_balance",
      status: 402,
    });
    await backend.discard({ name: "sanoma-stop" });
  });

  it("kills the commands still running when it stops, and fails at once on an SSH key the box refuses", async () => {
    const backend = backendOf();
    const box = await backend.open({ name: "sanoma-end", image: DEFAULTS.image, size: 2 });
    const left = await box.run("sleep 4243");
    await box.stop();
    expect((await left.wait()).exitCode).not.toBe(0);
    const again = await backend.open({ name: "sanoma-end", image: DEFAULTS.image, size: 2 });
    const found = await again.run("pgrep -fx 'sleep 4243' || true");
    expect(await new Response(found.stdout).text()).toBe("");
    await again.stop();
    // The workspace lost the key the backend registered: no wait brings it back.
    const kept = vendor.keys.splice(0);
    const begun = Date.now();
    await expect(backend.open({ name: "sanoma-end", image: DEFAULTS.image, size: 2 })).rejects.toThrow(
      "the SSH tunnel",
    );
    expect(Date.now() - begun).toBeLessThan(5_000);
    vendor.keys.push(...kept);
    await backend.discard({ name: "sanoma-end" });
  });

  it("refuses a shape Agent37 has not, and opens nothing without its key", async () => {
    await expect(backendOf({ size: 2, memory: 8 }).open({ name: "x", image: "", size: 2 })).rejects.toThrow(
      "Agent37's shapes",
    );
    const keyless = agent37Backend({ secrets: async () => new Map(), declared: {} });
    await expect(keyless.open({ name: "x", image: "", size: 2 })).rejects.toThrow("AGENT37_API_KEY is not set");
  });
});

describe("sshKey", () => {
  it("derives one ed25519 key per API key, which ssh2 reads and signs with", () => {
    const { privateKey, publicKey } = sshKey(KEY);
    expect(sshKey(KEY)).toEqual({ privateKey, publicKey });
    expect(sshKey("sk_live_other").publicKey).not.toBe(publicKey);
    const parsed = utils.parseKey(privateKey);
    if (parsed instanceof Error) throw parsed;
    expect(parsed.type).toBe("ssh-ed25519");
    expect(`ssh-ed25519 ${parsed.getPublicSSH().toString("base64")} sanoma`).toBe(publicKey);
    const data = Buffer.from("signed");
    expect(parsed.verify(data, parsed.sign(data))).toBe(true);
  });
});
