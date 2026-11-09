import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppBundle } from "sanoma/app";
import { testDatabaseUrl, testWorkerConfig } from "sanoma/testing";
import { memoryLedger } from "sanoma/workflows";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { Listening } from "../src/listen.ts";
import { listenWorkerPort, type Run, runWorker, type WorkerPortOptions } from "../src/worker-port.ts";
import { copyFixture, ensureBuilt, runCli } from "./fixture.ts";

// The worker's port over a fake `Run`: the checkout (with its install) and the revision's own
// `sanoma app-bundle` are the commands it is given, the second writing what a build would, or, for
// a copy of `fixtures/sites`, running this checkout's bin there. `buildAppBundle` itself is tested
// in `packages/sanoma/app/test/app-bundle.test.ts`, the runtime image in CI's runtime-image job.

const TOKEN = "swi_the-company-token";
const R1 = "0123456789abcdef0123456789abcdef01234567";
const R2 = "89abcdef0123456789abcdef0123456789abcdef";
const work = mkdtempSync(join(tmpdir(), "sanoma-worker-port-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const root = join(work, "company");
const sites = fileURLToPath(new URL("./fixtures/sites/", import.meta.url));

/** What the next `sanoma app-bundle` writes, by revision: a bundle or a failure. */
const built = new Map<string, unknown>();
/** Held until released, so a test sees the 202 while it builds. */
let hold: Promise<void> = Promise.resolve();
const run = vi.fn<Run>(async (command, args, cwd) => {
  if (command === "checkout") return void mkdirSync(args[0]!, { recursive: true });
  if (args[0] !== "exec") return;
  await hold;
  const revision = cwd.slice(`${root}-`.length);
  const result = built.get(revision);
  if (result instanceof Error) throw result;
  writeFileSync(args.at(-1)!, JSON.stringify(result));
});

/** What a build writes, as far as the route is concerned: it hands the file on as it is. */
const BUNDLE: AppBundle = {
  version: "v1",
  mainModule: "index.js",
  modules: [],
  assets: [],
  compatibilityDate: "2026-01-01",
  compatibilityFlags: ["nodejs_compat"],
  prerendered: [],
};

const onWake = vi.fn<() => void>();
const log = vi.fn<(line: string) => void>();
let port: Listening;
const listen = (options: Partial<WorkerPortOptions> = {}) =>
  listenWorkerPort(root, {
    host: "127.0.0.1",
    port: 0,
    onWake,
    token: TOKEN,
    checkout: "checkout",
    log,
    run,
    ...options,
  });
beforeEach(async () => {
  built.clear();
  run.mockClear();
  port = await listen();
});
afterEach(() => port.stop());

const ask = (revision: string, token = TOKEN) =>
  fetch(`${port.url}/__sanoma/app-bundle?revision=${revision}`, { headers: { authorization: `Bearer ${token}` } });

/** Asks until the build settled: what it answers then. */
async function settled(revision: string) {
  for (;;) {
    const res = await ask(revision);
    if (res.status !== 202) return res;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("the worker's port", () => {
  it("answers /healthz, hands /wake on and 404s the rest", async () => {
    const health = await fetch(`${port.url}/healthz`);
    expect([health.status, await health.text()]).toEqual([200, "ok\n"]);
    const wake = await fetch(`${port.url}/wake?generation=3`);
    expect(wake.status).toBe(204);
    expect(wake.headers.get("cache-control")).toBe("no-store");
    expect(onWake).toHaveBeenCalledOnce();
    expect((await fetch(`${port.url}/`)).status).toBe(404);
    expect((await fetch(`${port.url}/wake`, { method: "POST" })).status).toBe(404);
  });

  it("builds a revision's bundle beside the checkout, 202 until built, then 200 from the cache", async () => {
    built.set(R1, BUNDLE);
    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    const first = await ask(R1);
    expect(first.status).toBe(202);
    expect(first.headers.get("x-sanoma-app-bundle")).toBe("1");
    expect((await ask(R1)).status).toBe(202);
    release();
    const done = await settled(R1);
    expect(done.status).toBe(200);
    expect(done.headers.get("x-sanoma-app-bundle")).toBe("1");
    expect(await done.json()).toEqual(BUNDLE);
    const dir = `${root}-${R1}`;
    expect(run.mock.calls).toEqual([
      ["checkout", [dir, R1], root],
      ["pnpm", ["exec", "sanoma", "app-bundle", "--out", `${dir}.json`], dir],
    ]);
    // Built once, the checkout gone, the bundle kept beside it.
    expect(await (await ask(R1)).json()).toEqual(BUNDLE);
    expect(run).toHaveBeenCalledTimes(2);
    expect([existsSync(dir), existsSync(`${dir}.json`)]).toEqual([false, true]);
  });

  it("answers 500 once for a failed build, and builds again on the next ask", async () => {
    built.set(R2, new Error("pnpm exec sanoma app-bundle exited 1: sites/www/routes/index.tsx: Unexpected token"));
    const failed = await settled(R2);
    expect(failed.status).toBe(500);
    expect((await failed.json()) as { error: string }).toEqual({ error: expect.stringContaining("Unexpected token") });
    built.set(R2, BUNDLE);
    expect((await ask(R2)).status).toBe(202);
    expect((await settled(R2)).status).toBe(200);
  });

  it("tells when it starts building and when the last build queued ends", async () => {
    built.set(R1, BUNDLE);
    built.set(R2, BUNDLE);
    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    const building: boolean[] = [];
    await port.stop();
    port = await listen({ onBuilding: (now) => building.push(now) });
    expect((await ask(R1)).status).toBe(202);
    expect((await ask(R2)).status).toBe(202);
    expect(building).toEqual([true]);
    release();
    await settled(R1);
    await settled(R2);
    expect(building).toEqual([true, false]);
  });

  it("refuses another token, no token and a revision that is not a commit id, building nothing", async () => {
    expect((await ask(R1, "swi_another")).status).toBe(401);
    expect((await fetch(`${port.url}/__sanoma/app-bundle?revision=${R1}`)).status).toBe(401);
    expect((await ask("main")).status).toBe(400);
    expect((await ask("../etc")).status).toBe(400);
    await port.stop();
    port = await listen({ token: undefined });
    expect((await ask(R1)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the worker's port on a company", () => {
  beforeAll(ensureBuilt, 600_000);

  it("answers the AppBundle a revision's own `sanoma app-bundle` builds, its site prerendered at its domain", async () => {
    // The checkout is a link to a copy of `fixtures/sites` (whose install links into the copy), its
    // build this checkout's bin, as the image's are the company's.
    const copy = copyFixture(sites);
    onTestFinished(() => rmSync(copy, { recursive: true, force: true }));
    const company: Run = async (command, args, cwd) => {
      if (command === "checkout") return symlinkSync(copy, args[0]!);
      const done = await runCli(cwd, args.slice(2), { SANOMA_DOMAINS: "hello=hello.example" });
      if (done.code !== 0) throw new Error(done.stderr);
    };
    await port.stop();
    port = await listen({ run: company });
    const res = await settled(R1);
    const body = await res.text();
    expect(res.status, body).toBe(200);
    const bundle = JSON.parse(body) as AppBundle;
    expect(bundle.modules.map((m) => m.name)).toContain(bundle.mainModule);
    expect(bundle.assets.length).toBeGreaterThan(0);
    expect(bundle.prerendered).toContainEqual(
      expect.objectContaining({ site: "hello", domain: "hello.example", path: "/" }),
    );
    expect(bundle.assets.map((a) => a.path)).toEqual(expect.arrayContaining(bundle.prerendered.map((p) => p.asset)));
  }, 600_000);
});

describe("sanoma worker on a host that starts it again", () => {
  const databaseUrl = testDatabaseUrl("worker_port_exit");
  const company = join(work, "exiting");
  mkdirSync(company, { recursive: true });
  // A checkout that waits until released, then fails: a build under way, for as long as the test says.
  const release = join(work, "release");
  const checkout = join(work, "checkout.sh");
  writeFileSync(checkout, `#!/bin/sh\nwhile [ ! -f "${release}" ]; do sleep 0.1; done\nexit 1\n`);
  chmodSync(checkout, 0o755);
  const pool = new Pool({ connectionString: databaseUrl });
  afterAll(() => pool.end());
  const stoppedAt = async () =>
    (
      await pool.query<{ at: Date | null }>("select stopped_at as at from sanoma_wakeup where id = 1")
    ).rows[0]?.at?.getTime() ?? 0;

  it(
    "exits once its worker stopped itself, a build under way holding it until a fresh worker stops",
    { timeout: 120_000 },
    async () => {
      // Any address: no deadline is registered.
      vi.stubEnv("SANOMA_HOST_URL", "http://127.0.0.1:9");
      vi.stubEnv("SANOMA_WAKEUP_TOKEN", TOKEN);
      vi.stubEnv("SANOMA_CHECKOUT", checkout);
      vi.stubEnv("PORT", "0");
      // Beyond loopback, as in a container: a worker there stops itself.
      vi.stubEnv("SANOMA_APP_HOST", "0.0.0.0");
      onTestFinished(() => void vi.unstubAllEnvs());
      const lines: string[] = [];
      const worker = await runWorker(
        testWorkerConfig({ workflows: [], connectors: [], root: company, ledger: memoryLedger() }, databaseUrl),
        (line) => lines.push(line),
      );
      onTestFinished(() => worker.stop());
      let exited = false;
      void worker.exited?.then(() => (exited = true));
      const at = lines.find((line) => line.startsWith("the worker's port at "))!.slice("the worker's port at ".length);
      const before = await stoppedAt();
      const bundle = await fetch(`${at}/__sanoma/app-bundle?revision=${R1}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(bundle.status).toBe(202);
      // The worker stops itself at its first check, idle; the build holds the process.
      await vi.waitFor(async () => expect(await stoppedAt()).toBeGreaterThan(before), {
        timeout: 40_000,
        interval: 200,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(exited).toBe(false);
      // The build ends: a fresh worker starts, and once it stops itself the process is done.
      const first = await stoppedAt();
      writeFileSync(release, "");
      await vi.waitFor(() => expect(exited).toBe(true), { timeout: 60_000, interval: 200 });
      expect(await stoppedAt()).toBeGreaterThan(first);
    },
  );
});
