import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { testDatabaseUrl, waitFor } from "sanoma/testing";
import { mintInstanceToken } from "sanoma/workflows/wakeup-service";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { copyFixture, FIXTURE_GRID, ensureBuilt, runCli, serving, startCli } from "./fixture.ts";

// Needs Postgres (`pnpm db:up`) and the packages' builds: the fixture copy loads them as a
// company repo would, from `dist/`, so `beforeAll` builds those that are stale.
const env = { SANOMA_DATABASE_URL: testDatabaseUrl("sanoma-cli"), SANOMA_APP_PORT: "0" };
/** Ghost's variables unset: the fixture's one vendor is not configured. */
const unconfigured = { ...env, GHOST_ADMIN_URL: "", GHOST_ADMIN_API_KEY: "" };

let dir = "";

/** Where `server` listens once it does, on a free port of 127.0.0.1. */
async function listening(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** An address nothing listens at: one a server had, closed. */
async function closedAddress(): Promise<string> {
  const server = createServer();
  const url = await listening(server);
  await new Promise((done) => server.close(done));
  return url;
}
beforeAll(ensureBuilt, 600_000);
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("sanoma serve", () => {
  it("runs the worker and the app, prints what is not configured in one line and where, and stops on SIGINT", async () => {
    dir = copyFixture();
    // No key: serve makes one into .env before the worker starts.
    const { child, finished, output } = startCli(dir, ["serve"], {
      ...unconfigured,
      SANOMA_SECRETS_KEY: "",
      SANOMA_SIGNING_KEY: "",
    });
    try {
      const stdout = await waitFor(
        () => output().stdout,
        (out) => /Sanoma Fixture at http:\/\/127\.0\.0\.1:\d+/.test(out),
        30_000,
      );
      expect(stdout).toContain("Sanoma Fixture running hello");
      const { stderr } = output();
      // The worker's one line, naming the vendor; nothing per variable, and no pg deprecation
      // (DBOS's per-connection SET, see DBOS_DATABASE_OPTIONS).
      expect(stderr).toContain("sanoma: 1 of 1 connectors not configured yet: ghost; set their variables");
      expect(stderr).toMatch(/created SANOMA_SECRETS_KEY in \S+\.env/);
      expect(stderr).toMatch(/created SANOMA_SIGNING_KEY in \S+\.env/);
      expect(readFileSync(join(dir, ".env"), "utf8")).toMatch(
        /^SANOMA_SIGNING_KEY=[A-Za-z0-9+/]{43}=\nSANOMA_SECRETS_KEY=[A-Za-z0-9+/]{43}=\n$/,
      );
      expect(`${stdout}${stderr}`).not.toMatch(/is not configured|DeprecationWarning/);
      const url = stdout.match(/at (http:\/\/127\.0\.0\.1:\d+); ctrl-c to stop/)![1]!;
      // The app is up: its home lists the config's one workflow, and the built-in call, rendered on the server.
      const res = await fetch(`${url}/workflows`);
      expect(res.status).toBe(200);
      const html = await res.text();
      const rows = html.matchAll(/<td[^>]*><div[^>]*><a[^>]*href="\/workflows\/([^"?]+)"/g);
      // The company's workflow, and the change and call workflows and the app's actions every config has.
      expect([...rows].map(([, name]) => name)).toEqual([
        "adopt",
        "call",
        "change",
        "chat",
        "connect-existing",
        "follow",
        "go-live",
        "go-live-cloud",
        "go-live-host",
        "hello",
        "patch",
        "save-draft",
      ]);
      // On a config without problems: startApp warns about any it finds in the files before it listens.
      expect(output().stderr).not.toContain("the config's files have problems");
      // No sites: the build the app ships, and nothing written under .sanoma but the generated files.
      // And where it listens, for `sanoma call`: this process's, until it stops.
      expect(readdirSync(join(dir, ".sanoma"))).toEqual(["api.ts", "app.json", "schema.cedarschema"]);
      expect(JSON.parse(readFileSync(join(dir, ".sanoma/app.json"), "utf8"))).toEqual({ url, pid: child.pid });
    } finally {
      child.kill("SIGINT");
    }
    const done = await Promise.race([
      finished,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("did not exit")), 15_000)),
    ]);
    expect(done.code, done.stderr).toBe(0);
    expect(existsSync(join(dir, ".sanoma/app.json"))).toBe(false);
  }, 60_000);
});

describe("sanoma wakeup", () => {
  // As under the desktop shell's `pnpm dlx sanoma`, which passes on a signal its process group got too.
  it("with SANOMA_EVENTS, takes a second signal as the same stop", async () => {
    dir = copyFixture();
    const { child, finished } = await serving(dir, ["wakeup"], { ...unconfigured, SANOMA_EVENTS: "1" });
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGTERM"), 5);
    const done = await finished;
    expect(done.code, done.stderr).toBe(0);
  }, 60_000);

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
    expect(stdout.split("\n").slice(-3)).toEqual([`Sanoma Fixture at ${url}; ctrl-c to stop`, ready, ""]);
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

  it("brackets the company's own Postgres in the database stage, which a failure leaves without its done", async () => {
    dir = copyFixture();
    // No URL named: the company's own, which `app` only finds running, and none runs.
    const failed = await runCli(dir, ["app"], { ...events, SANOMA_DATABASE_URL: "" });
    expect(failed.code).toBe(2);
    const [first, last, ...rest] = failed.stdout.trimEnd().split("\n");
    expect(JSON.parse(first!)).toEqual({ sanoma: 1, event: "stage", stage: "database", status: "start" });
    expect(JSON.parse(last!)).toMatchObject({
      sanoma: 1,
      event: "error",
      message: expect.stringContaining("no Postgres runs"),
    });
    expect(rest).toEqual([]);
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
# The first block bootstraps the runtime. Secret references use the configured store; to read
# an environment value through that store, declare an explicit env binding in sanoma.config.ts.
# Connector driver migration to named per-call authentication is tracked separately.

# Optional. Postgres for the worker and the app; default the company's own in .sanoma/postgres.
# SANOMA_DATABASE_URL=
# Built-in encrypted store only: 32 random bytes, base64. Keep separately from database backups.
# SANOMA_SECRETS_KEY=
# SANOMA_SECRETS_KEY_FILE=
# App signing: an independent 32-byte base64 key. Changing it invalidates signed sessions.
# For each key, use its value OR its _FILE path. First local start generates missing keys.
# SANOMA_SIGNING_KEY=
# SANOMA_SIGNING_KEY_FILE=
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
    // The last line: the result, with the Permissions grid (no policies, so everyone may).
    expect(ok.stdout.endsWith("\n")).toBe(true);
    const checked: unknown = JSON.parse(ok.stdout.trimEnd().split("\n").at(-1)!);
    expect(checked).toEqual({
      sanoma: 1,
      event: "checked",
      ok: true,
      problems: [],
      warnings: [],
      grid: FIXTURE_GRID,
    });
    // The lines check prints, not all of stdout: on a fresh database DBOS logs "Created database …" there.
    expect(ok.stderr).toContain("passed scenarios/hello/hello.feature › A post goes out");
    expect(ok.stderr.trimEnd().split("\n").at(-1)).toBe("ok");
    // The scenarios use the fakes alone: no credentials to report, and nothing but check's own lines and DBOS's setup.
    expect(`${ok.stdout}${ok.stderr}`).not.toMatch(/not configured|DeprecationWarning|Error in step/);
  }, 180_000);
});

describe("sanoma describe and sanoma call, against a running app", () => {
  // One app for the describe: the fixture with people (those the tests below name as they ask, from
  // copies of their own) and an agent, on a database of its own, so its runs of hello never reach
  // the other tests' (the Workflows page lists by the latest run).
  const calls = { ...unconfigured, SANOMA_DATABASE_URL: testDatabaseUrl("sanoma-call") };
  let served = "";
  let server: Awaited<ReturnType<typeof serving>> | undefined;
  beforeAll(async () => {
    served = copyFixture();
    mkdirSync(join(served, "resources"));
    writeFileSync(
      join(served, "resources/people.ts"),
      `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
export const lin = sanoma.person({ id: "lin" });
export const founder = sanoma.person({ id: "founder" });
export const claudeCode = sanoma.agent({ id: "claude-code", client: "claude-code" });
`,
    );
    server = await serving(served, ["serve"], calls);
  }, 120_000);
  afterAll(async () => {
    await server?.stop();
    rmSync(served, { recursive: true, force: true });
  }, 30_000);
  /** The bin in `cwd` (the served copy's directory unless named), its stdout parsed when it exited 0. */
  const sanoma = async (
    args: string[],
    { cwd = served, more = {} }: { cwd?: string; more?: NodeJS.ProcessEnv } = {},
  ) => {
    const done = await runCli(cwd, args, { ...calls, ...more });
    return { ...done, json: done.code === 0 ? (JSON.parse(done.stdout) as any) : undefined };
  };
  /** The served app's address, asked as ada. */
  const at = () => ["--url", server!.url, "--as", "ada"];
  /** hello started as ada by the declared agent `agent`. */
  const asAgent = (agent: string) =>
    sanoma(["call", "hello", "--input", '{"title":"Agent"}', ...at(), "--agent", agent]);
  /** Who started the run `runId` of hello, from `hello.runs`. */
  const startedBy = async (runId: string) => {
    const runs = await sanoma(["call", "hello.runs", ...at()]);
    return (runs.json as { runId: string; startedBy?: { id: string } }[]).find((r) => r.runId === runId)?.startedBy;
  };

  it("describes the company's own workflows as JSON, on one line, and nothing else on stdout", async () => {
    const described = await sanoma(["describe", ...at()]);
    expect(described.code, described.stderr).toBe(0);
    expect(described.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(described.json.workflows.map((wf: { name: string }) => wf.name)).toEqual(["hello"]);
  });

  it("starts a workflow, printing its run, and reads the run's failure, exiting 1", async () => {
    const started = await sanoma(["call", "hello", "--input", '{"title":"Hi"}', ...at()]);
    expect(started.code, started.stderr).toBe(0);
    expect(Object.keys(started.json)).toEqual(["runId"]);
    const { runId } = started.json as { runId: string };
    const result = await sanoma(["call", "hello.result", "--input", JSON.stringify({ runId }), ...at()]);
    // Ghost is not configured, so the run fails: its error, its code and its run on stderr, nothing on stdout.
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/\(driver_failed\)\nrun [\w-]+\n$/);
    expect(result.stderr).toContain(`run ${runId}`);
    // A run's reads take no start: its list, by the person who started it.
    expect(await startedBy(runId)).toMatchObject({ id: "ada" });
  });

  it("names the input's issues, and refuses the runtime's own workflows however written, exiting 2", async () => {
    const invalid = await sanoma(["call", "hello", "--input", '{"title":""}', ...at()]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toMatch(/\(invalid_input\)/);
    expect(invalid.stderr).toMatch(/^ {2}title: /m);
    for (const name of ["change", "go-live", "goLive", "goLive.start", "login-code", "drift.start"]) {
      const refused = await sanoma(["call", name, ...at()]);
      expect(refused.code, name).toBe(2);
      expect(refused.stderr, name).toMatch(
        /is the runtime's own workflow: the runtime's own workflows are not started here/,
      );
    }
  });

  it("exits 2 for a mistake in the call: no name, input that is not JSON, an unknown flag, a flag of another command", async () => {
    const mistakes = [
      ["call", ...at()],
      ["call", "hello", "--input", "{", ...at()],
      ["call", "hello", "--nope", ...at()],
      ["describe", "--input", "{}", ...at()],
      ["describe", "extra", ...at()],
      ["check", "--as", "ada"],
      ["env", "--url", server!.url],
      ["describe", "--url", "not a url", "--as", "ada"],
      ["describe", "--as", "", "--url", server!.url],
      ["describe", "--as", "ada", "--agent", " ", "--url", server!.url],
      ["describe", "--id", "x", ...at()],
      ["call", "hello.result", "--id", "x", "--input", '{"runId":"r"}', ...at()],
      ["call", "hello", "--id", "not/an id", ...at()],
      ["env", "--id", "x"],
    ];
    const done = [];
    for (const args of mistakes) {
      const one = await sanoma(args);
      expect(one.code, args.join(" ")).toBe(2);
      expect(one.stdout, args.join(" ")).toBe("");
      done.push(one);
    }
    expect(done[1]!.stderr).toMatch(/^--input is not JSON/);
    expect(done[5]!.stderr).toMatch(/^--input, --id, --as, --url and --agent are sanoma describe's and sanoma call's/);
  });

  it("exits 1 naming the address it tried when nothing answers there", async () => {
    const done = await sanoma(["describe", "--url", "http://127.0.0.1:1", "--as", "ada"]);
    expect(done.code).toBe(1);
    expect(done.stdout).toBe("");
    expect(done.stderr).toMatch(/^Nothing answers at http:\/\/127\.0\.0\.1:1 /);
  });

  it("finds the app by .sanoma/app.json, and ignores one whose process is gone", async () => {
    // SANOMA_APP_PORT is 0 here: only the file says where.
    const found = await sanoma(["describe", "--as", "ada"]);
    expect(found.code, found.stderr).toBe(0);
    expect(found.json.workflows).toHaveLength(1);
    // Another directory, whose file names an app that crashed: the port in the environment, then.
    const other = copyFixture();
    try {
      mkdirSync(join(other, ".sanoma"));
      writeFileSync(join(other, ".sanoma/app.json"), JSON.stringify({ url: "http://127.0.0.1:1", pid: 2 ** 30 }));
      const port = new URL(server!.url).port;
      const stale = await sanoma(["describe", "--as", "ada"], { cwd: other, more: { SANOMA_APP_PORT: port } });
      expect(stale.code, stale.stderr).toBe(0);
      // With port 0 and no running app to say where: a mistake in the call.
      const unknown = await sanoma(["describe", "--as", "ada"], { cwd: other });
      expect(unknown.code).toBe(2);
      expect(unknown.stderr).toMatch(/^SANOMA_APP_PORT is 0.*--url/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("asks as the one person declared, as git's user.email says among several, or as --as says by id or email", async () => {
    const other = copyFixture();
    const gitConfig = join(other, "gitconfig");
    // Git's own configuration alone: no user.email unless this test writes one.
    const git = { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
    writeFileSync(gitConfig, "");
    const people = (lines: string[]) =>
      writeFileSync(
        join(other, "resources/people.ts"),
        `import { sanoma } from "sanoma/resources";\n\n${lines.join("\n")}\n`,
      );
    /** Who started the run `sanoma call hello` starts from `other` with `args`: the served app admits anyone. */
    const starter = async (args: string[]) => {
      const started = await sanoma(["call", "hello", "--input", '{"title":"Who"}', "--url", server!.url, ...args], {
        cwd: other,
        more: git,
      });
      return started.code === 0 ? (await startedBy(started.json.runId))?.id : started;
    };
    try {
      mkdirSync(join(other, "resources"), { recursive: true });
      // Nobody declared: --as is needed.
      const nobody = await sanoma(["describe", "--url", server!.url], { cwd: other, more: git });
      expect(nobody.code).toBe(2);
      expect(nobody.stderr).toMatch(/^No person is declared in resources\/: say who is asking with --as <id>/);
      people([`export const founder = sanoma.person({ id: "founder", email: "founder@acme.test" });`]);
      expect(await starter([])).toBe("founder");
      people([
        `export const ada = sanoma.person({ id: "ada", email: "ada@acme.test" });`,
        `export const lin = sanoma.person({ id: "lin", email: "lin@acme.test", github: "lin-gh" });`,
      ]);
      const several = await sanoma(["describe", "--url", server!.url], { cwd: other, more: git });
      expect(several.code).toBe(2);
      expect(several.stderr).toMatch(
        /^Say who is asking with --as <id, email or GitHub login>: the people are ada, lin\n/,
      );
      expect(await starter(["--as", "LIN@acme.test"])).toBe("lin");
      expect(await starter(["--as", "lin-gh"])).toBe("lin");
      expect(await starter(["--as", "ada"])).toBe("ada");
      const stranger = await sanoma(["describe", "--url", server!.url, "--as", "bob@acme.test"], {
        cwd: other,
        more: git,
      });
      expect(stranger.code).toBe(2);
      expect(stranger.stderr).toMatch(/^--as: bob@acme\.test is no declared person; the people are ada, lin/);
      writeFileSync(gitConfig, "[user]\n\temail = lin@acme.test\n");
      expect(await starter([])).toBe("lin");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  }, 60_000);

  it("works from under the company's directory, and needs a company or --url and --as outside one", async () => {
    // SANOMA_APP_PORT is 0: the company's .sanoma/app.json says where.
    const below = await sanoma(["describe", "--as", "ada"], { cwd: join(served, "workflows") });
    expect(below.code, below.stderr).toBe(0);
    const empty = mkdtempSync(join(tmpdir(), "sanoma-nowhere-"));
    try {
      const nowhere = await sanoma(["describe", "--as", "ada"], { cwd: empty });
      expect(nowhere.code).toBe(2);
      expect(nowhere.stderr).toMatch(/^No sanoma\.config\.ts in /);
      const nobody = await sanoma(["describe", "--url", server!.url], { cwd: empty });
      expect(nobody.code).toBe(2);
      expect(nobody.stderr).toMatch(/--as/);
      const named = await sanoma(["describe", ...at()], { cwd: empty });
      expect(named.code, named.stderr).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("takes the company above an app that kept its own config, and stops at a node_modules", async () => {
    const other = copyFixture();
    try {
      mkdirSync(join(other, ".sanoma"));
      writeFileSync(join(other, ".sanoma/app.json"), JSON.stringify({ url: server!.url, pid: process.pid }));
      // An app merged from a company's repo keeps that repo's config: the company is the one above.
      mkdirSync(join(other, "apps/crm/workflows"), { recursive: true });
      writeFileSync(join(other, "apps/crm/sanoma.config.ts"), "");
      const inApp = await sanoma(["describe", "--as", "ada"], { cwd: join(other, "apps/crm/workflows") });
      expect(inApp.code, inApp.stderr).toBe(0);
      // Under a node_modules is a package's directory, no company's.
      mkdirSync(join(other, "node_modules/some-package"), { recursive: true });
      const inPackage = await sanoma(["describe", "--as", "ada"], { cwd: join(other, "node_modules/some-package") });
      expect(inPackage.code).toBe(2);
      expect(inPackage.stderr).toMatch(/^No sanoma\.config\.ts in /);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("from a draft, asks the company's running app as its people say", async () => {
    const other = copyFixture();
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@acme.test", ...args], { cwd: other });
    try {
      writeFileSync(join(other, ".gitignore"), "node_modules/\n.sanoma/\n");
      git("init", "-q", "-b", "main");
      git("add", ".");
      git("commit", "-q", "-m", "x");
      git("worktree", "add", "-q", ".sanoma/drafts/d1", "-b", "draft/d1");
      // The company's alone, uncommitted: the draft has none, the app reads these.
      mkdirSync(join(other, "resources"));
      writeFileSync(
        join(other, "resources/people.ts"),
        `import { sanoma } from "sanoma/resources";\n\nexport const founder = sanoma.person({ id: "founder" });\n`,
      );
      writeFileSync(join(other, ".sanoma/app.json"), JSON.stringify({ url: server!.url, pid: process.pid }));
      const draft = join(other, ".sanoma/drafts/d1/workflows");
      const started = await sanoma(["call", "hello", "--input", '{"title":"Draft"}'], { cwd: draft });
      expect(started.code, started.stderr).toBe(0);
      expect(await startedBy(started.json.runId)).toMatchObject({ id: "founder" });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("finds an app folder's own running app before its company's", async () => {
    const other = copyFixture();
    try {
      // `sanoma` run in apps/crm, which kept its own config: its discovery file is there, none above.
      mkdirSync(join(other, "apps/crm/.sanoma"), { recursive: true });
      mkdirSync(join(other, "apps/crm/workflows"));
      writeFileSync(join(other, "apps/crm/sanoma.config.ts"), "");
      writeFileSync(join(other, "apps/crm/.sanoma/app.json"), JSON.stringify({ url: server!.url, pid: process.pid }));
      const inApp = await sanoma(["describe", "--as", "ada"], { cwd: join(other, "apps/crm/workflows") });
      expect(inApp.code, inApp.stderr).toBe(0);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("trusts .sanoma/app.json only for an address on this machine, and says so when nothing answers there", async () => {
    const other = copyFixture();
    try {
      mkdirSync(join(other, ".sanoma"));
      // A live process (this one), at an address beyond this machine: ignored for the environment's port.
      const file = join(other, ".sanoma/app.json");
      writeFileSync(file, JSON.stringify({ url: "http://192.0.2.1:9", pid: process.pid }));
      const port = new URL(server!.url).port;
      const planted = await sanoma(["describe", "--as", "ada"], { cwd: other, more: { SANOMA_APP_PORT: port } });
      expect(planted.code, planted.stderr).toBe(0);
      // On this machine, where nothing listens: the message names the file it came from.
      writeFileSync(file, JSON.stringify({ url: await closedAddress(), pid: process.pid }));
      const gone = await sanoma(["describe", "--as", "ada"], { cwd: other });
      expect(gone.code).toBe(1);
      expect(gone.stderr).toMatch(
        /^Nothing answers at http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\); the address is the one \S+\/\.sanoma\/app\.json names: /,
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("makes a start with the same --id once, and refuses that id for another input", async () => {
    const id = crypto.randomUUID();
    const start = (title: string) =>
      sanoma(["call", "hello", "--input", JSON.stringify({ title }), "--id", id, ...at()]);
    expect((await start("Once")).json).toEqual({ runId: id });
    expect((await start("Once")).json).toEqual({ runId: id });
    const runs = await sanoma(["call", "hello.runs", ...at()]);
    expect((runs.json as { runId: string }[]).filter((r) => r.runId === id)).toHaveLength(1);
    const other = await start("Twice");
    expect(other.code).toBe(1);
    expect(other.stdout).toBe("");
    expect(other.stderr).toMatch(/\(invalid_input\)/);
  });

  it("calls as a declared agent for the person with --agent, and refuses a person named as one", async () => {
    const started = await asAgent("claude-code");
    expect(started.code, started.stderr).toBe(0);
    expect(await startedBy(started.json.runId)).toEqual({ id: "claude-code", groups: ["agents"], onBehalfOf: "ada" });
    const person = await asAgent("lin");
    expect(person.code).toBe(1);
    expect(person.stderr).toMatch(/\(not_admitted\)/);
  });
});

describe("sanoma call against a stand-in app", () => {
  let stand: ReturnType<typeof createServer> | undefined;
  let requests = 0;
  /** What the stand-in answers every request: its status and body. */
  let answer = { status: 409, body: { error: "still running", code: "run_running", runId: "r1" } as object };
  let at = "";
  /** Who the last request said was asking. */
  let actor: string | undefined;
  beforeAll(async () => {
    stand = createServer((req, res) => {
      requests++;
      actor = req.headers["x-sanoma-actor"] as string | undefined;
      req.resume().on("end", () => {
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
      });
    });
    at = await listening(stand);
  });
  afterAll(() => stand?.close());

  it("asks a running run's result again a second apart at least, and stops on SIGINT saying the run goes on", async () => {
    dir = copyFixture();
    requests = 0;
    const waiting = startCli(
      dir,
      ["call", "hello.result", "--input", '{"runId":"r1","waitMs":0}', "--url", at, "--as", "ada"],
      env,
    );
    await new Promise((done) => setTimeout(done, 3_500));
    waiting.child.kill("SIGINT");
    const done = await waiting.finished;
    // At once, then after a second, two and three: never a flood.
    expect(requests).toBeGreaterThanOrEqual(2);
    expect(requests).toBeLessThanOrEqual(5);
    expect(done.code).toBe(130);
    expect(done.stdout).toBe("");
    expect(done.stderr).toBe("stopped waiting: run r1 goes on, ask again for its result\n");
  });

  it("prints the server's words without a terminal's control characters, and a plain 400 without the host's hint", async () => {
    dir = copyFixture();
    answer = {
      status: 400,
      body: { error: "bad \u001b[31mred\u0007 thing\tok\u007f\u0085\u009b2J", code: "invalid_input" },
    };
    const done = await runCli(dir, ["call", "hello", "--url", at, "--as", "ada"], env);
    expect(done.code).toBe(1);
    expect(done.stderr).toBe("bad [31mred thing\tok2J (invalid_input)\n");
    // With SANOMA_EVENTS=1 too, as a terminal under the desktop shell has it: stdout is the answer's alone.
    const events = await runCli(dir, ["call", "hello", "--url", at, "--as", "ada"], { ...env, SANOMA_EVENTS: "1" });
    expect([events.code, events.stdout]).toEqual([1, ""]);
    const usage = await runCli(dir, ["describe", "--nope"], { ...env, SANOMA_EVENTS: "1" });
    expect([usage.code, usage.stdout]).toEqual([2, ""]);
  });

  it("asks as the person whose id --as names, before one whose GitHub login reads the same", async () => {
    dir = copyFixture();
    mkdirSync(join(dir, "resources"));
    writeFileSync(
      join(dir, "resources/people.ts"),
      `import { sanoma } from "sanoma/resources";

export const sam = sanoma.person({ id: "sam", github: "samuel" });
export const samantha = sanoma.person({ id: "samantha", github: "sam" });
`,
    );
    answer = { status: 200, body: {} };
    for (const [as, id] of [
      ["sam", "sam"],
      ["samuel", "sam"],
      ["samantha", "samantha"],
    ] as const) {
      const done = await runCli(dir, ["describe", "--url", at, "--as", as], env);
      expect([done.code, actor], as).toEqual([0, id]);
    }
  });

  it("says when the app the discovery file names signs people in, which these commands do not", async () => {
    dir = copyFixture();
    mkdirSync(join(dir, ".sanoma"));
    writeFileSync(join(dir, ".sanoma/app.json"), JSON.stringify({ url: at, pid: process.pid, signIn: true }));
    answer = {
      status: 400,
      body: { error: "This request does not say who is making it: sign in", code: "invalid_input" },
    };
    const done = await runCli(dir, ["describe", "--as", "ada"], env);
    expect(done.code).toBe(1);
    expect(done.stderr).toMatch(
      /\nThe app at http:\/\/127\.0\.0\.1:\d+ listens beyond this machine \(\S+\.sanoma\/app\.json says so\), so it signs people in with the staff login/,
    );
  });

  it("names no id, and no password, for a call that was never sent", async () => {
    dir = copyFixture();
    const refused = await runCli(
      dir,
      ["call", "hello", "--id", "never-1", "--url", await closedAddress(), "--as", "ada"],
      env,
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/^Nothing answers at .* \(ECONNREFUSED\)/);
    expect(refused.stderr).not.toContain("never-1");
    const secret = await runCli(
      dir,
      ["call", "hello", "--id", "never-2", "--url", "http://u:secret@127.0.0.1:1", "--as", "ada"],
      env,
    );
    expect(secret.code).toBe(2);
    expect(secret.stderr).toMatch(/^--url names a user or a password/);
    expect(secret.stderr).not.toMatch(/secret|never-2/);
  });

  it("names the call's id when the app may have taken it, so the same call can be made again", async () => {
    dir = copyFixture();
    // A connection the app drops once it has the request.
    const dropping = createServer((req) => req.socket.destroy());
    const url = await listening(dropping);
    try {
      const done = await runCli(dir, ["call", "hello", "--id", "retry-1", "--url", url, "--as", "ada"], env);
      expect(done.code).toBe(1);
      expect(done.stderr).toMatch(
        /\nThe call's id was retry-1: running the command again with --id retry-1 is the same call, not a second one\n$/,
      );
    } finally {
      dropping.close();
    }
  });
});

describe("the commands that run nothing", () => {
  it("load neither the worker nor the app: --help, env, describe and call", async () => {
    dir = copyFixture();
    // A hook that writes every module the bin loads, at its exit.
    const hook = join(dir, "loaded.mjs");
    writeFileSync(
      hook,
      `import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
const seen = [];
registerHooks({ load(url, context, next) { seen.push(url); return next(url, context); } });
process.on("exit", () => appendFileSync(process.env.LOADED, seen.join("\\n") + "\\n"));
`,
    );
    // The app's modules and the commands that start the worker never; `env` resolves the config with
    // the runtime (`sanoma/workflows`, whose entry holds the worker's module too), the rest load not even that.
    const app = /\/sanoma\/(app\/(dist|src)\/|(dist|src)\/(serve|worker-port)\.[jt]s$)/;
    const worker = /\/sanoma\/workflows\/(dist|src)\/worker\.[jt]s$/;
    const runs: string[][] = [
      ["--help"],
      ["env"],
      ["describe", "--url", "http://127.0.0.1:1", "--as", "ada"],
      ["call", "hello", "--url", "http://127.0.0.1:1"],
    ];
    for (const args of runs) {
      const loaded = join(tmpdir(), `sanoma-loaded-${process.pid}-${args[0]}`);
      rmSync(loaded, { force: true });
      const done = await runCli(dir, args, { ...env, NODE_OPTIONS: `--import ${hook}`, LOADED: loaded });
      expect(done.code, done.stderr).not.toBeNull();
      const urls = readFileSync(loaded, "utf8").split("\n").filter(Boolean);
      rmSync(loaded, { force: true });
      expect(urls.length, args.join(" ")).toBeGreaterThan(1);
      const loadsTooMuch = (url: string) => app.test(url) || (args[0] !== "env" && worker.test(url));
      expect(urls.filter(loadsTooMuch), args.join(" ")).toEqual([]);
    }
  }, 60_000);
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
