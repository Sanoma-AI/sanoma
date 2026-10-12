import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testDatabaseUrl } from "@sanoma/testing";
import type { ConfigDescription } from "@sanoma/workflows/describe";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { copyFixture, ensureBuilt, runCli, startCli, waitFor } from "./fixture.ts";

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
      await waitFor(
        () => /sanoma-fixture at http:\/\/127\.0\.0\.1:\d+/.test(output().stdout),
        "the app's address",
        30_000,
      );
      const { stdout } = output();
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
    // The fixture's one driver is the fake's, which declares no variables: the first block alone.
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
`);
    expect((await runCli(dir, ["env", "--check"], env)).code).toBe(0);
    appendFileSync(join(dir, ".env.example"), "EXTRA=\n");
    const stale = await runCli(dir, ["env", "--check"], env);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("`.env.example` is out of date: run `sanoma env`");
  });
});

describe("sanoma check", () => {
  it("passes the fixture, then fails on an import a workflow may not make, then on a scenario step that does not hold", async () => {
    dir = copyFixture();
    const ok = await runCli(dir, ["check"], env);
    expect(ok.code, `${ok.stdout}${ok.stderr}`).toBe(0);
    expect(ok.stderr).toContain("passed hello/hello.feature › A post goes out");

    const workflow = join(dir, "workflows/hello.ts");
    const source = readFileSync(workflow, "utf8");
    appendFileSync(workflow, 'import { readFileSync } from "node:fs";\n');
    const badImport = await runCli(dir, ["check"], env);
    expect(badImport.code).toBe(1);
    expect(badImport.stdout).toMatch(/^workflows\/hello\.ts:16:\d+: import "node:fs" is not allowed in a workflow/m);
    writeFileSync(workflow, source);

    const feature = join(dir, "scenarios/hello/hello.feature");
    writeFileSync(feature, readFileSync(feature, "utf8").replace("And the run succeeds", "And the run fails"));
    const badScenario = await runCli(dir, ["check"], env);
    expect(badScenario.code).toBe(1);
    expect(badScenario.stdout).toContain("A post goes out › the run fails: the run finished");
  }, 180_000);
});

describe("sanoma --help and mistakes", () => {
  it("prints the usage, and exits 2 for an unknown command or a directory without a config", async () => {
    dir = copyFixture();
    const help = await runCli(dir, ["--help"], env);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("sanoma check");
    expect(help.stdout).not.toContain("sanoma serve");
    const unknown = await runCli(dir, ["nope"], env);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown command "nope"');
    rmSync(join(dir, "sanoma.config.ts"));
    const missing = await runCli(dir, ["env"], env);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/^No sanoma\.config\.ts in /);
  });
});
