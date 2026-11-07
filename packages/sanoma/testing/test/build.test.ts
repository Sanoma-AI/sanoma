import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLock, ensureBuilt } from "../src/build.ts";

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
    writeFileSync(join(pkg, "src/index.ts"), "");
  });
  afterEach(() => rmSync(pkg, { recursive: true, force: true }));

  it("builds once for processes that find it stale at the same moment", async () => {
    const script = `import(${JSON.stringify(module)}).then((m) => m.ensureBuilt(${JSON.stringify(pkg)}, ["out"], ${JSON.stringify(build)}))`;
    await Promise.all([1, 2, 3].map(() => run(process.execPath, ["-e", script])));
    expect(builds()).toBe(1);
  });

  it("builds when any output is older than a source, and marks one the build left as it was built", () => {
    // Two parts' outputs, the second older than the source; the build rewrites only the first, as
    // `tsc -b` leaves a project it finds up to date.
    const touchFirst = ["sh", "-c", "echo built >> builds; touch first"] as const;
    const old = new Date(Date.now() - 60_000);
    writeFileSync(join(pkg, "first"), "");
    writeFileSync(join(pkg, "second"), "");
    utimesSync(join(pkg, "second"), old, old);
    utimesSync(join(pkg, "src/index.ts"), new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
    ensureBuilt(pkg, ["first", "second"], touchFirst);
    expect(builds()).toBe(1);
    ensureBuilt(pkg, ["first", "second"], touchFirst);
    expect(builds()).toBe(1);
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(pkg, "src/index.ts"), later, later);
    ensureBuilt(pkg, ["first", "second"], touchFirst);
    expect(builds()).toBe(2);
  });

  it("takes over the lock of a build that was killed", () => {
    const lock = buildLock(pkg);
    writeFileSync(lock, String(spawnSync("true").pid));
    ensureBuilt(pkg, ["out"], build);
    expect(builds()).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });
});
