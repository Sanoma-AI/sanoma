import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { devRepo, end, linkedPackages, partialLink, supervise } from "../src/dev.ts";
import { waitFor } from "@sanoma-ai/testing";

let dir = "";
const temp = () => (dir = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-dev-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A repo whose `node_modules/@sanoma-ai/<name>` (or `sanoma`) are symlinks into `checkout/packages/`, or real directories. */
function repoWith(links: Record<string, "linked" | "installed">): { repo: string; checkout: string } {
  const root = temp();
  const repo = join(root, "repo");
  const checkout = join(root, "checkout");
  mkdirSync(join(repo, "node_modules", "@sanoma-ai"), { recursive: true });
  for (const [name, how] of Object.entries(links)) {
    const at = name === "sanoma" ? join(repo, "node_modules", name) : join(repo, "node_modules", "@sanoma-ai", name);
    if (how === "installed") {
      mkdirSync(at);
      continue;
    }
    const target = join(checkout, "packages", name);
    mkdirSync(target, { recursive: true });
    symlinkSync(target, at);
  }
  return { repo, checkout };
}

describe("devRepo", () => {
  it("is the checkout a linked package is in: sanoma itself, or any @sanoma-ai package", () => {
    const linkedWorkflows = repoWith({ workflows: "linked" });
    expect(devRepo(linkedWorkflows.repo)).toBe(linkedWorkflows.checkout);
    const linkedSanoma = repoWith({ sanoma: "linked", workflows: "installed" });
    expect(devRepo(linkedSanoma.repo)).toBe(linkedSanoma.checkout);
  });

  it("is nothing for installed packages, or none", () => {
    expect(devRepo(repoWith({ workflows: "installed", sanoma: "installed" }).repo)).toBeUndefined();
    expect(devRepo(repoWith({}).repo)).toBeUndefined();
  });

  it("is SANOMA_DEV_REPO when set", () => {
    vi.stubEnv("SANOMA_DEV_REPO", "/elsewhere/sanoma");
    expect(devRepo(repoWith({ workflows: "installed" }).repo)).toBe("/elsewhere/sanoma");
  });
});

describe("linkedPackages", () => {
  it("lists the linked packages under @sanoma-ai/ and sanoma, with where they are", () => {
    const { repo, checkout } = repoWith({ workflows: "linked", app: "linked", testing: "installed", sanoma: "linked" });
    expect(linkedPackages(repo)).toEqual([
      { name: "@sanoma-ai/app", dir: join(checkout, "packages/app") },
      { name: "@sanoma-ai/workflows", dir: join(checkout, "packages/workflows") },
      { name: "sanoma", dir: join(checkout, "packages/sanoma") },
    ]);
    expect(linkedPackages(repoWith({}).repo)).toEqual([]);
  });
});

describe("partialLink", () => {
  it("names the core packages still installed when another is linked, each found as Node finds it", () => {
    // pnpm's layout: sanoma from its tarball, with @sanoma-ai/app and @sanoma-ai/workflows beside it in
    // .pnpm, not at the top; @sanoma-ai/workflows linked at the top; @sanoma-ai/bridge installed there.
    const { repo } = repoWith({ workflows: "linked", bridge: "installed" });
    const store = join(repo, "node_modules/.pnpm/sanoma@0.1.0/node_modules");
    for (const name of ["sanoma", "@sanoma-ai/app", "@sanoma-ai/workflows"])
      mkdirSync(join(store, name), { recursive: true });
    symlinkSync(join(store, "sanoma"), join(repo, "node_modules/sanoma"));
    expect(partialLink(repo)).toEqual(["sanoma", "@sanoma-ai/app", "@sanoma-ai/bridge"]);

    // All four linked (the umbrella's own dependencies then resolve inside the checkout): nothing.
    const all = repoWith({ sanoma: "linked", workflows: "linked", app: "linked", bridge: "linked" });
    expect(partialLink(all.repo)).toEqual([]);
    // None linked: nothing either.
    expect(partialLink(repoWith({ sanoma: "installed", workflows: "installed" }).repo)).toEqual([]);
  });
});

/** A Node child in a group of its own that prints its pid, then, with `grandchild`, a grandchild's pid too. */
function child(
  pids: number[],
  { grandchild = false, exitAfterMs }: { grandchild?: boolean; exitAfterMs?: number } = {},
) {
  const script = [
    "console.log(process.pid);",
    grandchild &&
      `const g = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(g.pid);`,
    exitAfterMs === undefined ? "setInterval(() => {}, 1000);" : `setTimeout(() => process.exit(3), ${exitAfterMs});`,
  ]
    .filter(Boolean)
    .join(" ");
  const c = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"], detached: true });
  c.stdout.on("data", (chunk: Buffer) => pids.push(...chunk.toString().trim().split(/\s+/).map(Number)));
  return c;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A `dist` directory to watch, made a moment before: macOS's file events can report a directory's
 * creation to a watch started right after it.
 */
async function distDir(): Promise<string> {
  const watched = join(temp(), "dist");
  mkdirSync(watched);
  await new Promise((r) => setTimeout(r, 300));
  return watched;
}

describe("supervise", () => {
  it("restarts the child after a write into a watched directory, not an ignored one, and stops it", async () => {
    const watched = await distDir();
    const ignored = join(watched, "client");
    mkdirSync(ignored);
    await new Promise((r) => setTimeout(r, 300));
    const pids: number[] = [];
    const log: string[] = [];
    const supervised = supervise({
      spawn: () => child(pids),
      watch: [watched],
      ignore: [ignored],
      debounceMs: 100,
      log: (line) => log.push(line),
    });
    try {
      await waitFor(() => pids.length === 1);
      writeFileSync(join(ignored, "main.js"), "");
      await new Promise((r) => setTimeout(r, 400));
      expect(pids).toHaveLength(1);
      writeFileSync(join(watched, "index.js"), "");
      await waitFor(() => pids.length === 2);
      expect(pids[1]).not.toBe(pids[0]);
      expect(log).toEqual(["a package's dist changed; restarting"]);
      expect(alive(pids[0]!)).toBe(false);
    } finally {
      await supervised.stop();
    }
    expect(alive(pids[1]!)).toBe(false);
  });

  it("reports a child that exits on its own, and starts it again on the next change, not before", async () => {
    const watched = await distDir();
    const pids: number[] = [];
    const log: string[] = [];
    let started = 0;
    const supervised = supervise({
      spawn: () => child(pids, started++ === 0 ? { exitAfterMs: 100 } : {}),
      watch: [watched],
      debounceMs: 100,
      log: (line) => log.push(line),
    });
    try {
      await waitFor(() => log.length === 1);
      expect(log).toEqual(["serve exited with code 3; waiting for a change to restart"]);
      await new Promise((r) => setTimeout(r, 300));
      expect(started).toBe(1);
      writeFileSync(join(watched, "index.js"), "");
      await waitFor(() => pids.length === 2);
      expect(started).toBe(2);
    } finally {
      await supervised.stop();
    }
    expect(alive(pids[1]!)).toBe(false);
  });
});

describe("end", () => {
  it("ends the child's whole process group", async () => {
    const pids: number[] = [];
    const c = child(pids, { grandchild: true });
    await waitFor(() => pids.length === 2);
    await end(c);
    await waitFor(() => !alive(pids[1]!));
    expect(alive(pids[0]!)).toBe(false);
  });

  it("resolves at once for a child that has exited, or that never started", async () => {
    const pids: number[] = [];
    const exited = child(pids, { exitAfterMs: 0 });
    await new Promise((r) => exited.once("exit", r));
    await expect(end(exited)).resolves.toBeUndefined();
    const never = spawn(join(temp(), "no-such-bin"), [], { detached: true });
    never.on("error", () => {});
    await expect(end(never)).resolves.toBeUndefined();
  });
});
