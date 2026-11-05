import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureBuilt } from "../src/build.ts";

const run = promisify(execFile);
const module = new URL("../src/build.ts", import.meta.url).href;

describe("ensureBuilt", () => {
  let pkg: string;
  // Appends a line per build, then writes the output a moment later, as a build takes time.
  const build = ["sh", "-c", "echo built >> builds; sleep 0.5; touch out"] as const;
  const builds = () => readFileSync(join(pkg, "builds"), "utf8").trim().split("\n").length;

  beforeEach(() => {
    pkg = mkdtempSync(join(tmpdir(), "sanoma-ensure-built-"));
    mkdirSync(join(pkg, "src"));
    mkdirSync(join(pkg, "node_modules"));
    writeFileSync(join(pkg, "src/index.ts"), "");
  });
  afterEach(() => rmSync(pkg, { recursive: true, force: true }));

  it("builds once for processes that find it stale at the same moment", async () => {
    const script = `import(${JSON.stringify(module)}).then((m) => m.ensureBuilt(${JSON.stringify(pkg)}, ["out"], ${JSON.stringify(build)}))`;
    await Promise.all([1, 2, 3].map(() => run(process.execPath, ["-e", script])));
    expect(builds()).toBe(1);
  });

  it("takes over the lock of a build that was killed", () => {
    const lock = join(pkg, "node_modules/.ensure-built.lock");
    mkdirSync(lock);
    const long = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, long, long);
    ensureBuilt(pkg, ["out"], build);
    expect(builds()).toBe(1);
  });
});
