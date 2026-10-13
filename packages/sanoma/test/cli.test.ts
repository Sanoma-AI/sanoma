import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { testDatabaseUrl, waitFor } from "@sanoma/testing";
import type { ConfigDescription } from "@sanoma/workflows/describe";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { copyFixture, ensureBuilt, runCli, startCli } from "./fixture.ts";

// Needs Postgres (`pnpm db:up`) and the packages' builds: the fixture copy loads them as a
// company repo would, from `dist/`, so `beforeAll` builds those that are stale.
const env = { SANOMA_DATABASE_URL: testDatabaseUrl("sanoma-cli"), SANOMA_APP_PORT: "0" };

let dir = "";
beforeAll(ensureBuilt, 600_000);
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("sanoma serve", () => {
  it("runs the worker and the app, prints where, and stops on SIGINT", async () => {
    dir = copyFixture();
    const { child, finished, output } = startCli(dir, ["serve"], env);
    try {
      const stdout = await waitFor(
        () => output().stdout,
        (out) => /sanoma-fixture at http:\/\/127\.0\.0\.1:\d+/.test(out),
        30_000,
      );
      expect(stdout).toContain("sanoma-fixture running hello");
      const url = stdout.match(/at (http:\/\/127\.0\.0\.1:\d+); ctrl-c to stop/)![1]!;
      const res = await fetch(`${url}/api/config`);
      expect(res.status).toBe(200);
      const config = (await res.json()) as ConfigDescription;
      expect(config.workflows.map((w) => w.name)).toEqual(["hello"]);
      expect(config.problems).toEqual([]);
    } finally {
      child.kill("SIGINT");
    }
    const done = await Promise.race([
      finished,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("did not exit")), 15_000)),
    ]);
    expect(done.code, done.stderr).toBe(0);
  }, 60_000);
});

describe("sanoma env", () => {
  it("writes .env.example, and --check says when it is out of date", async () => {
    dir = copyFixture();
    const wrote = await runCli(dir, ["env"], env);
    expect(wrote.code, wrote.stderr).toBe(0);
    // The first block, then the variables of the fixture's one connector's driver, Ghost's.
    expect(readFileSync(join(dir, ".env.example"), "utf8"))
      .toBe(`# Copy to .env (ignored by git; \`sanoma\` loads it before reading the config). Never commit values.
# The first block is what sanoma needs before anything runs. The vendor variables below it can
# also be set on the app's connector pages (stored in the database and loaded by the worker); a
# value set here wins over a stored one and cannot be changed from the page. An empty value is
# the same as unset.

# Optional. Postgres for the worker and the app; default postgresql://postgres:dbos@localhost:5433/sanoma.
# SANOMA_DATABASE_URL=
# Optional. The app's port; default 3000.
# SANOMA_APP_PORT=

# ghost: the site's admin URL, such as https://example.ghost.io
GHOST_ADMIN_URL=
# ghost: a custom integration's Admin API key, <id>:<secret>
GHOST_ADMIN_API_KEY=
`);
    appendFileSync(join(dir, ".env.example"), "EXTRA=\n");
    const stale = await runCli(dir, ["env", "--check"], env);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("`.env.example` is out of date: run `sanoma env`");
  });
});

describe("sanoma check", () => {
  it("passes the fixture: Postgres, tsc, oxlint, the config and its scenario, then ok and exit 0", async () => {
    dir = copyFixture();
    const ok = await runCli(dir, ["check"], env);
    expect(ok.code, `${ok.stdout}${ok.stderr}`).toBe(0);
    // The lines check prints, not all of stdout: on a fresh database DBOS logs "Created database …" there.
    expect(ok.stderr).toContain("passed hello/hello.feature › A post goes out");
    expect(ok.stderr.trimEnd().split("\n").at(-1)).toBe("ok");
  }, 180_000);
});

describe("sanoma --help and mistakes", () => {
  it("prints the usage, and exits 2 for an unknown command or option, a missing value, or a directory without a config", async () => {
    dir = copyFixture();
    const help = await runCli(dir, ["--help"], env);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("sanoma check");
    expect(help.stdout).not.toContain("sanoma serve");
    const unknown = await runCli(dir, ["nope"], env);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown command "nope"');
    const option = await runCli(dir, ["check", "--nope"], env);
    expect(option.code).toBe(2);
    expect(option.stderr).toMatch(/^Unknown option '--nope'/);
    const value = await runCli(dir, ["ledger", "export", "r1", "--out"], env);
    expect(value.code).toBe(2);
    expect(value.stderr).toMatch(/^Option '--out <value>' argument missing/);
    rmSync(join(dir, "sanoma.config.ts"));
    const missing = await runCli(dir, ["env"], env);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/^No sanoma\.config\.ts in /);
  });
});
