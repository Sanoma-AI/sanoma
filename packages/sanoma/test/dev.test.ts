import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { devRepo, linkedPackages, supervise } from "../src/dev.ts";
import { waitFor } from "./fixture.ts";

let dir = "";
const temp = () => (dir = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-dev-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A repo whose `node_modules/@sanoma/<name>` are symlinks into `checkout/packages/`, or real directories. */
function repoWith(links: Record<string, "linked" | "installed" | "vite">): { repo: string; checkout: string } {
  const root = temp();
  const repo = join(root, "repo");
  const checkout = join(root, "checkout");
  mkdirSync(join(repo, "node_modules", "@sanoma"), { recursive: true });
  for (const [name, how] of Object.entries(links)) {
    const at = name === "sanoma" ? join(repo, "node_modules", name) : join(repo, "node_modules", "@sanoma", name);
    if (how === "installed") {
      mkdirSync(at);
      continue;
    }
    const target = join(checkout, "packages", name);
    mkdirSync(target, { recursive: true });
    if (how === "vite") writeFileSync(join(target, "vite.config.ts"), "");
    symlinkSync(target, at);
  }
  return { repo, checkout };
}

describe("devRepo", () => {
  it("is the checkout a linked @sanoma/workflows is in", () => {
    const { repo, checkout } = repoWith({ workflows: "linked" });
    expect(devRepo(repo)).toBe(checkout);
  });

  it("is nothing for an installed @sanoma/workflows, or none", () => {
    expect(devRepo(repoWith({ workflows: "installed" }).repo)).toBeUndefined();
    expect(devRepo(repoWith({}).repo)).toBeUndefined();
  });

  it("is SANOMA_DEV_REPO when set", () => {
    vi.stubEnv("SANOMA_DEV_REPO", "/elsewhere/sanoma");
    expect(devRepo(repoWith({ workflows: "installed" }).repo)).toBe("/elsewhere/sanoma");
  });
});

describe("linkedPackages", () => {
  it("lists the linked packages under @sanoma/ and sanoma, with where they are and whether vite builds them", () => {
    const { repo, checkout } = repoWith({ workflows: "linked", app: "vite", testing: "installed", sanoma: "linked" });
    expect(linkedPackages(repo)).toEqual([
      { name: "@sanoma/app", dir: join(checkout, "packages/app"), vite: true },
      { name: "@sanoma/workflows", dir: join(checkout, "packages/workflows"), vite: false },
      { name: "sanoma", dir: join(checkout, "packages/sanoma"), vite: false },
    ]);
    expect(linkedPackages(repoWith({}).repo)).toEqual([]);
  });
});

describe("supervise", () => {
  it("restarts the child after a write into a watched directory, and stops it", async () => {
    const watched = join(temp(), "dist");
    const pids: number[] = [];
    const log: string[] = [];
    const child = supervise({
      spawn: () => {
        const c = spawn(process.execPath, ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"], {
          stdio: ["ignore", "pipe", "inherit"],
        });
        c.stdout.on("data", (chunk: Buffer) => pids.push(Number(chunk.toString())));
        return c;
      },
      watch: [watched],
      debounceMs: 100,
      log: (line) => log.push(line),
    });
    try {
      await waitFor(() => pids.length === 1, "the first child", 10_000);
      writeFileSync(join(watched, "index.js"), "");
      await waitFor(() => pids.length === 2, "the restarted child", 10_000);
      expect(pids[1]).not.toBe(pids[0]);
      expect(log).toEqual(["a package's dist changed; restarting"]);
      // The first child is gone.
      expect(() => process.kill(pids[0]!, 0)).toThrow("ESRCH");
    } finally {
      await child.stop();
    }
    expect(() => process.kill(pids[1]!, 0)).toThrow("ESRCH");
  });
});
