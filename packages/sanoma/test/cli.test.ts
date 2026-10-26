import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import { mintInstanceToken } from "@sanoma-ai/workflows/wakeup-service";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { copyFixture, ensureBuilt, runCli, serving, startCli } from "./fixture.ts";

// Needs Postgres (`pnpm db:up`) and the packages' builds: the fixture copy loads them as a
// company repo would, from `dist/`, so `beforeAll` builds those that are stale.
const env = { SANOMA_DATABASE_URL: testDatabaseUrl("sanoma-cli"), SANOMA_APP_PORT: "0" };
/** Ghost's variables unset: the fixture's one vendor is not configured. */
const unconfigured = { ...env, GHOST_ADMIN_URL: "", GHOST_ADMIN_API_KEY: "" };

let dir = "";
beforeAll(ensureBuilt, 600_000);
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("sanoma serve", () => {
  it("runs the worker and the app, prints what is not configured in one line and where, and stops on SIGINT", async () => {
    dir = copyFixture();
    // No key: serve makes one into .env before the worker starts.
    const { child, finished, output } = startCli(dir, ["serve"], { ...unconfigured, SANOMA_SECRETS_KEY: "" });
    try {
      const stdout = await waitFor(
        () => output().stdout,
        (out) => /sanoma-fixture at http:\/\/127\.0\.0\.1:\d+/.test(out),
        30_000,
      );
      expect(stdout).toContain("sanoma-fixture running hello");
      const { stderr } = output();
      // The worker's one line, naming the vendor; nothing per variable, and no pg deprecation
      // (DBOS's per-connection SET, see DBOS_DATABASE_OPTIONS).
      expect(stderr).toContain("sanoma: 1 of 1 connectors not configured yet: ghost; set their variables");
      expect(stderr).toMatch(/created SANOMA_SECRETS_KEY in \S+\.env: it encrypts the stored credentials/);
      expect(readFileSync(join(dir, ".env"), "utf8")).toMatch(/^SANOMA_SECRETS_KEY=[A-Za-z0-9+/]{43}=\n$/);
      expect(`${stdout}${stderr}`).not.toMatch(/is not configured|DeprecationWarning/);
      const url = stdout.match(/at (http:\/\/127\.0\.0\.1:\d+); ctrl-c to stop/)![1]!;
      // The app is up: its home lists the config's one workflow, rendered on the server.
      const res = await fetch(`${url}/workflows`);
      expect(res.status).toBe(200);
      const html = await res.text();
      const rows = html.matchAll(/<td[^>]*><div[^>]*><a[^>]*href="\/workflows\/([^"?]+)"/g);
      expect([...rows].map(([, name]) => name)).toEqual(["hello"]);
      // On a config without problems: startApp warns about any it finds in the files before it listens.
      expect(output().stderr).not.toContain("the config's files have problems");
      // No sites: the build the app ships, and nothing written under .sanoma but the generated files.
      expect(readdirSync(join(dir, ".sanoma"))).toEqual(["api.ts", "schema.cedarschema"]);
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

describe("sanoma wakeup", () => {
  it("serves the wakeup service's routes and /healthz alone, and stops on SIGINT", async () => {
    dir = copyFixture();
    const { url, stop, output } = await serving(dir, ["wakeup"], unconfigured);
    expect(output().stdout).toBe(`the wakeup service at ${url}; ctrl-c to stop\n`);
    const health = await fetch(`${url}/healthz`);
    expect([health.status, await health.text()]).toEqual([200, "ok\n"]);
    const res = await fetch(`${url}/wakeup/instances`, {
      method: "POST",
      body: JSON.stringify({ url: "http://x.test" }),
    });
    expect([res.status, res.headers.get("cache-control"), await res.json()]).toEqual([
      401,
      "no-store",
      { error: "an account's token is needed" },
    ]);
    // Nothing of the app.
    expect((await fetch(`${url}/workflows`)).status).toBe(404);
    // An account minted beside it registers an instance.
    const minted = await runCli(dir, ["wakeup", "account", "acme"], unconfigured);
    expect(minted.code, minted.stderr).toBe(0);
    const { token } = JSON.parse(minted.stdout) as { token: string };
    const made = await fetch(`${url}/wakeup/instances`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: "http://x.test", token: mintInstanceToken() }),
    });
    expect([made.status, Object.keys((await made.json()) as object)]).toEqual([201, ["id"]]);
    // The body is read once the token is known, and only so far.
    const huge = await fetch(`${url}/wakeup/instances`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "x".repeat(100_000),
    });
    expect(huge.status).toBe(413);
    expect((await runCli(dir, ["wakeup", "account"], unconfigured)).code).toBe(2);
    await stop();
  }, 60_000);

  it("is mounted in sanoma serve by wakeup: true, ahead of the login", async () => {
    dir = copyFixture();
    const file = join(dir, "sanoma.config.ts");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("connectors: [ghost],", "connectors: [ghost],\n  wakeup: true,"),
    );
    const { url, stop } = await serving(dir, ["serve"], unconfigured);
    const res = await fetch(`${url}/wakeup/instances/00000000-0000-4000-8000-000000000000`, {
      headers: { host: "wakeup.example" },
    });
    expect([res.status, await res.json()]).toEqual([401, { error: "an account's token is needed" }]);
    await stop();
  }, 60_000);
});

describe("SANOMA_EVENTS=1, for a parent process", () => {
  const events = { ...unconfigured, SANOMA_EVENTS: "1" };

  it("prints the ready line after the human one, and stops on the end of stdin", async () => {
    dir = copyFixture();
    const { url, output, child, finished } = await serving(dir, ["app"], events);
    const ready = JSON.stringify({ sanoma: 1, event: "ready", url, sites: {} });
    const stdout = await waitFor(
      () => output().stdout,
      (out) => out.includes(ready),
      10_000,
    );
    // Right after the line a person reads.
    expect(stdout.split("\n").slice(-3)).toEqual([`sanoma-fixture at ${url}; ctrl-c to stop`, ready, ""]);
    child.stdin!.end();
    const done = await finished;
    expect(done.code, done.stderr).toBe(0);
    // One event line: the end of stdin is a stop, not a failure.
    expect(done.stdout.match(/^\{/gm)).toHaveLength(1);
  }, 60_000);

  it("prints the error line before exiting 2 on a broken config, and nothing on stdout without the variable", async () => {
    dir = copyFixture();
    writeFileSync(join(dir, "sanoma.config.ts"), "export default {};\n");
    const failed = await runCli(dir, ["app"], events);
    expect(failed.code).toBe(2);
    const message = failed.stderr.trimEnd();
    expect(message).toMatch(/sanoma\.config\.ts must export a config as its default export/);
    expect(failed.stdout).toBe(`${JSON.stringify({ sanoma: 1, event: "error", message })}\n`);
    const quiet = await runCli(dir, ["app"], unconfigured);
    expect(quiet.code).toBe(2);
    expect(quiet.stdout).toBe("");
  });
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

# Optional. Postgres for the worker and the app; default the company's own in .sanoma/postgres.
# SANOMA_DATABASE_URL=
# Optional. Encrypts the stored credentials, and signs GitHub sign-in's cookie: 32 random bytes,
# base64. \`sanoma\` writes one here when none is set; keep it with the database.
# SANOMA_SECRETS_KEY=
# Optional. The app's port; default 3000.
# SANOMA_APP_PORT=
# Optional. The address the app listens on; default 127.0.0.1. Any other needs GitHub sign-in.
# SANOMA_APP_HOST=
# Optional. GitHub sign-in: the OAuth client of the company's GitHub App. Who may sign in is
# resources/people.ts. Both or neither.
# SANOMA_GITHUB_CLIENT_ID=
# SANOMA_GITHUB_CLIENT_SECRET=

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
  it("passes the fixture: Postgres, tsc, oxlint, the config and its scenario, then ok, the checked event and exit 0", async () => {
    dir = copyFixture();
    const ok = await runCli(dir, ["check"], { ...unconfigured, SANOMA_EVENTS: "1" });
    expect(ok.code, `${ok.stdout}${ok.stderr}`).toBe(0);
    const checked = { sanoma: 1, event: "checked", ok: true, problems: [], warnings: [] };
    expect(ok.stdout.endsWith(`${JSON.stringify(checked)}\n`)).toBe(true);
    // The lines check prints, not all of stdout: on a fresh database DBOS logs "Created database …" there.
    expect(ok.stderr).toContain("passed hello/hello.feature › A post goes out");
    expect(ok.stderr.trimEnd().split("\n").at(-1)).toBe("ok");
    // The scenarios use the fakes alone: no credentials to report, and nothing but check's own lines and DBOS's setup.
    expect(`${ok.stdout}${ok.stderr}`).not.toMatch(/not configured|DeprecationWarning|Error in step/);
  }, 180_000);
});

describe("sanoma --help and mistakes", () => {
  it("prints the usage, and exits 2 for an unknown command or option, a missing value, policies that do not hold, or a directory without a config", async () => {
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
    // A policy that does not hold starts nothing: exit 2, naming it at its place.
    mkdirSync(join(dir, "policies"));
    writeFileSync(join(dir, "policies/x.cedar"), "permit (principal, action, resource);\n");
    const policies = await runCli(dir, ["worker"], env);
    expect(policies.code).toBe(2);
    expect(policies.stderr).toMatch(
      /^The policies do not hold:\npolicies\/x\.cedar:1:1: policies\/x\.cedar#1: a permit is allowed only for visitors/,
    );
    rmSync(join(dir, "sanoma.config.ts"));
    const missing = await runCli(dir, ["env"], env);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/^No sanoma\.config\.ts in /);
  });
});
