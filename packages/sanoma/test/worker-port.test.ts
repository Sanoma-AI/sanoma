import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Listening } from "../src/listen.ts";
import { listenWorkerPort, type Run } from "../src/worker-port.ts";

// The worker's port over a fake `Run`: the checkout, the install and the revision's own
// `sanoma app-bundle` are commands it records, the last writing what a build would. `buildWorker`
// itself runs in `packages/app/test/worker-build.test.ts`, the runtime image in CI's runtime-image job.

const TOKEN = "swi_the-company-token";
const R1 = "0123456789abcdef0123456789abcdef01234567";
const R2 = "89abcdef0123456789abcdef0123456789abcdef";
const work = mkdtempSync(join(tmpdir(), "sanoma-worker-port-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const root = join(work, "company");

/** What the next `sanoma app-bundle` writes, by revision: a bundle, `null`, or a failure. */
const built = new Map<string, unknown>();
const calls: string[] = [];
/** Held until released, so a test sees the 202 while it builds. */
let hold: Promise<void> = Promise.resolve();
const run = vi.fn<Run>(async (command, args, cwd) => {
  calls.push(`${command} ${args.join(" ")} @ ${cwd}`);
  if (command === "checkout") return void mkdirSync(args[0]!, { recursive: true });
  if (args[0] !== "exec") return;
  await hold;
  const revision = cwd.slice(`${root}-`.length);
  const result = built.get(revision);
  if (result instanceof Error) throw result;
  const out = args.at(-1)!;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result));
});

const onWake = vi.fn<() => void>();
const log = vi.fn<(line: string) => void>();
let port: Listening;
beforeEach(async () => {
  built.clear();
  calls.length = 0;
  run.mockClear();
  port = await listenWorkerPort(root, {
    host: "127.0.0.1",
    port: 0,
    onWake,
    token: TOKEN,
    checkout: "checkout",
    log,
    run,
  });
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
    const bundle = { sites: ["www"], mainModule: "index.js", modules: [], assets: [] };
    built.set(R1, bundle);
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
    expect(await done.json()).toEqual(bundle);
    const dir = `${root}-${R1}`;
    expect(calls).toEqual([
      `checkout ${dir} ${R1} @ ${root}`,
      `pnpm install --frozen-lockfile --prefer-offline @ ${dir}`,
      `pnpm exec sanoma app-bundle --out ${join(dir, ".sanoma", "app-bundle.json")} @ ${dir}`,
    ]);
    // Built once, the checkout gone.
    expect(await (await ask(R1)).json()).toEqual(bundle);
    expect(run).toHaveBeenCalledTimes(3);
    expect(() => mkdirSync(dir)).not.toThrow();
  });

  it("answers 404 for a revision with nothing for the Worker, 500 once for a failed build", async () => {
    built.set(R1, null);
    built.set(R2, new Error("pnpm exec sanoma app-bundle exited 1: sites/www/routes/index.tsx: Unexpected token"));
    expect((await settled(R1)).status).toBe(404);
    const failed = await settled(R2);
    expect(failed.status).toBe(500);
    expect((await failed.json()) as { error: string }).toEqual({ error: expect.stringContaining("Unexpected token") });
    // The next ask builds again.
    built.set(R2, { sites: [], mainModule: "index.js", modules: [], assets: [] });
    expect((await ask(R2)).status).toBe(202);
    expect((await settled(R2)).status).toBe(200);
  });

  it("refuses another token, no token and a revision that is not a commit id, building nothing", async () => {
    expect((await ask(R1, "swi_another")).status).toBe(401);
    expect((await fetch(`${port.url}/__sanoma/app-bundle?revision=${R1}`)).status).toBe(401);
    expect((await ask("main")).status).toBe(400);
    expect((await ask("../etc")).status).toBe(400);
    await port.stop();
    port = await listenWorkerPort(root, {
      host: "127.0.0.1",
      port: 0,
      onWake,
      token: undefined,
      checkout: "x",
      log,
      run,
    });
    expect((await ask(R1)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
});
