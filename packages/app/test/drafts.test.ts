import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { copyFixture, ensureBuilt } from "../../sanoma/test/fixture.ts";
import { gitIdentity } from "../../sanoma/test/git.ts";
import { localGitSource } from "../../sanoma/src/source.ts";
import { checks } from "../src/server/drafts.ts";

// `checks` on drafts of the sanoma package's fixture company, in a git repository of its own: the
// installed bin as a child in each draft, on the packages' builds (made when stale) and Postgres.

let dir = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
beforeAll(() => {
  ensureBuilt();
  gitIdentity(vi.stubEnv);
  dir = copyFixture();
  writeFileSync(join(dir, ".gitignore"), ".sanoma/\nnode_modules/\n");
  git("init", "--quiet", "--initial-branch=main");
  git("add", "--all");
  git("commit", "--quiet", "-m", "First");
}, 600_000);
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("checks", () => {
  it("runs sanoma check in each draft, one at a time, with the live checkout untouched", async () => {
    const source = localGitSource(dir);
    const [ok, broken, unloadable] = await Promise.all([
      source.draft!("ok"),
      source.draft!("broken"),
      source.draft!("unloadable"),
    ]);
    writeFileSync(join(broken.root, "workflows", "broken.ts"), 'export const n: number = "one";\n');
    // Its config prints a passing result as it loads, which does not pass it: the launcher's comes last.
    const fake = JSON.stringify({ sanoma: 1, event: "checked", ok: true, problems: [], warnings: [] });
    const config = join(broken.root, "sanoma.config.ts");
    writeFileSync(config, `console.log(${JSON.stringify(fake)});\n${readFileSync(config, "utf8")}`);
    await broken.commit({ paths: ["workflows/broken.ts", "sanoma.config.ts"], message: "Break", author: "agent" });
    // A config that does not load, and says what the check's environment holds (but what macOS adds to every one).
    const names = 'Object.keys(process.env).filter((n) => !n.startsWith("__CF_")).sort().join(" ")';
    const says = `throw new Error(\`no config; env \${${names}}\`);\n`;
    writeFileSync(join(unloadable.root, "sanoma.config.ts"), says);
    await unloadable.commit({ paths: ["sanoma.config.ts"], message: "Unload", author: "agent" });
    // A credential of this process never reaches the check.
    vi.stubEnv("GHOST_ADMIN_API_KEY", "not-for-the-check");

    const databaseUrl = testDatabaseUrl("drafts");
    const [passed, failed, refused] = await Promise.all([
      checks(ok.root, databaseUrl),
      checks(broken.root, databaseUrl),
      checks(unloadable.root, databaseUrl),
    ]);
    expect(passed).toEqual({ ok: true, problems: [], warnings: [] });
    expect(failed.ok).toBe(false);
    expect(failed.problems).toContainEqual(expect.stringMatching(/^workflows\/broken\.ts:1:14: .*'string'.*'number'/));
    expect(refused).toEqual({
      ok: false,
      problems: [expect.stringMatching(/^sanoma check: .*no config; env HOME PATH SANOMA_DATABASE_URL SANOMA_EVENTS$/)],
      warnings: [],
    });

    expect(await source.drafts!()).toEqual(["broken", "ok", "unloadable"]);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("log", "--format=%s")).toBe("First");
  }, 300_000);
});
