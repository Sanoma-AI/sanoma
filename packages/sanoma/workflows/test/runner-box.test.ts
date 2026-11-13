import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { checkSandbox } from "sanoma/testing/sandbox";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runnerBox, runnerHealth, runnerScript } from "../src/runner-box.ts";
import { RUNNER_HEALTH, RUNNER_PROTOCOL } from "../src/runner-protocol.ts";
import type { Box, SandboxBackend } from "../src/sandbox-contract.ts";

// The runner as a backend ships it (`runnerScript()`, the built `dist/sandbox-runner.cjs`), written
// out of the repo and started with this `node` under a home of its own, as in a box; driven
// through `runnerBox` by the Sandbox conformance kit and by what the kit does not check.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-runner-")));
const home = join(scratch, "home");
let runner: ChildProcess;
let url: string;

beforeAll(async () => {
  mkdirSync(home);
  const script = join(scratch, "runner.cjs");
  writeFileSync(script, await runnerScript());
  runner = spawn(process.execPath, [script], {
    cwd: scratch,
    env: {
      HOME: home,
      PATH: [dirname(process.execPath), process.env.PATH].join(":"),
      SANOMA_RUNNER_HOST: "127.0.0.1",
      SANOMA_RUNNER_PORT: "0",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  // It says where it listens: `sanoma runner listening on <host>:<port>`.
  const [line] = await once(createInterface({ input: runner.stdout! }), "line");
  url = `http://${String(line).split(" ").at(-1)}`;
});
afterAll(async () => {
  runner.kill("SIGTERM");
  await new Promise((done) => runner.once("exit", done));
  rmSync(scratch, { recursive: true, force: true });
});

const boxOf = (): Box => ({
  ...runnerBox({ url, id: "runner" }),
  expose: async (port) => ({ url: `http://127.0.0.1:${port}` }),
});
/** The runner's machine as a backend: one box, its home emptied by `discard`. */
const backend: SandboxBackend = {
  open: async () => boxOf(),
  async discard() {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home);
  },
};
const text = (stream: ReadableStream<Uint8Array>) => new Response(stream).text();

describe("the sandbox runner", () => {
  it("answers its health check", async () => {
    expect(await (await fetch(`${url}${RUNNER_HEALTH}`)).json()).toEqual({
      protocol: RUNNER_PROTOCOL,
      pid: runner.pid,
    });
    expect(await runnerHealth(url)).toEqual({ protocol: RUNNER_PROTOCOL, pid: runner.pid });
    expect(await runnerHealth(`${url}/?a37_token=t`)).toEqual({ protocol: RUNNER_PROTOCOL, pid: runner.pid });
    expect(await runnerHealth(`${url}/other`)).toBeUndefined();
    expect((await fetch(`${url}/other`)).status).toBe(404);
  });

  it("asks for its health ahead of the URL's query, which a signed link's token rides in", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: URL) => {
      asked.push(String(input));
      return Response.json({ protocol: RUNNER_PROTOCOL, pid: 1 });
    });
    try {
      const health = { protocol: RUNNER_PROTOCOL, pid: 1 };
      expect(await runnerHealth("https://ab12cd34ef-7700.agent37.app/?a37_token=t")).toEqual(health);
      expect(await runnerHealth("https://ab12cd34ef-7700.agent37.app?a37_token=t")).toEqual(health);
      expect(await runnerHealth("https://box.example/base/?a=1&b=2")).toEqual(health);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(asked).toEqual([
      "https://ab12cd34ef-7700.agent37.app/runner/health?a37_token=t",
      "https://ab12cd34ef-7700.agent37.app/runner/health?a37_token=t",
      "https://box.example/base/runner/health?a=1&b=2",
    ]);
  });

  it("passes the sandbox conformance kit through runnerBox", async () => {
    const results = await checkSandbox({
      backend,
      capabilities: { snapshot: true, pause: false, port: true },
      image: "local",
      size: 1,
      timeoutMs: 10_000,
    });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results).toHaveLength(8);
  });

  it("runs commands side by side on one connection, in their cwd with their env, under the home", async () => {
    const box = boxOf();
    try {
      await box.write("work/x.txt", new TextEncoder().encode("hi"), { mode: 0o600 });
      const [a, b] = await Promise.all([
        box.run('pwd; cat x.txt; echo " $GREETING"', { cwd: "work", env: { GREETING: "it's 'quoted'" } }),
        box.run("echo out; echo err >&2; exit 3"),
      ]);
      expect(await Promise.all([text(a.stdout), a.wait()])).toEqual([
        `${home}/work\nhi it's 'quoted'\n`,
        { exitCode: 0 },
      ]);
      expect(await Promise.all([text(b.stdout), text(b.stderr), b.wait()])).toEqual([
        "out\n",
        "err\n",
        { exitCode: 3 },
      ]);
      expect(await box.read("nothing/here")).toBeNull();
      // An abort kills it.
      const aborting = new AbortController();
      const aborted = await box.run("sleep 30", { signal: aborting.signal });
      aborting.abort();
      expect((await aborted.wait()).exitCode).not.toBe(0);
      // A command without stdin refuses its input.
      const shut = await box.run("cat");
      await expect(shut.stdin.getWriter().write(new Uint8Array([1]))).rejects.toThrow("stdin: true");
      expect((await shut.wait()).exitCode).toBe(0);
    } finally {
      await box.stop();
    }
  });

  it("kills every command in the box at stop, those of another connection too", async () => {
    const one = boxOf();
    const two = boxOf();
    const left = await one.run("sleep 4247");
    await two.stop();
    expect((await left.wait()).exitCode).not.toBe(0);
    const found = await two.run("pgrep -fx 'sleep 4247' || true");
    expect(await text(found.stdout)).toBe("");
    await Promise.all([one.stop(), two.stop()]);
  });

  it("answers frames that are not the protocol's, and goes on", async () => {
    const ws = new WebSocket(url.replace(/^http/, "ws"));
    const said: string[] = [];
    ws.addEventListener("message", ({ data }) => said.push(String(data)));
    await new Promise((done) => ws.addEventListener("open", done, { once: true }));
    ws.send(new Uint8Array([1, 2]));
    ws.send("null");
    ws.send("{");
    await expect.poll(() => said.length).toBe(3);
    expect(said.map((s) => JSON.parse(s).op)).toEqual(["error", "error", "error"]);
    ws.close();
    expect(await runnerHealth(url)).toEqual({ protocol: RUNNER_PROTOCOL, pid: runner.pid });
  });

  it("fails what it cannot do as the runner's error", async () => {
    const box = boxOf();
    try {
      await expect(box.write("/dev/null/x", new Uint8Array())).rejects.toThrow(/the runner at 127\.0\.0\.1:\d+: /);
    } finally {
      await box.stop();
    }
  });
});
