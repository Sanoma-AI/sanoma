import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { resolveDatabaseUrl } from "@sanoma-ai/workflows";
import * as pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/config.ts";
import { clusterDir, ensurePostgres, masked, OLD_DEFAULT_URL } from "../src/postgres.ts";
import { gitIdentity } from "./git.ts";

// pg's `Client` (the probe, and `stop`'s count of other clients) is the real one unless a test
// stubs it. PostgreSQL itself is a fake `bin/` of shell scripts that write each call to
// `$FAKE_PG_LOG`; the stubbed probe answers once the fake `pg_ctl start` ran, or at the ports a
// test lists. embedded.test.ts runs the real binaries.
vi.mock("pg", async (importOriginal) => {
  const real = await importOriginal<typeof import("pg")>();
  return {
    ...real,
    Client: vi.fn<(config: pg.ClientConfig) => pg.Client>(function (config) {
      return new real.Client(config);
    }),
  };
});

const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

let dir = "";
let calls = "";
/** What the fake PostgreSQL was asked to do, one call per entry: `pg_ctl start -D …`. */
const ran = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);

/**
 * Stubs the probe: it answers at the ports in `up`, and at any once `pg_ctl start` ran; `stop`'s
 * count of other clients is `others`.
 */
function stubPostgres({ up = [] as number[], others = 0 } = {}) {
  vi.mocked(pg.Client).mockImplementation(function (config: pg.ClientConfig) {
    const port = Number(config.port ?? new URL(config.connectionString!).port);
    return {
      connect: async () => {
        if (!up.includes(port) && !ran().some((call) => call.startsWith("pg_ctl start"))) throw refused();
      },
      query: async () => ({ rows: [{ others }] }),
      end: async () => {},
    } as unknown as pg.Client;
  } as unknown as typeof pg.Client);
}

/** A directory holding a fake PostgreSQL `bin/`: `initdb` makes the data directory and its config, `pg_ctl` does nothing. */
function fakeBin(): string {
  const bin = join(dir, "pg");
  mkdirSync(join(bin, "bin"), { recursive: true });
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, "bin", name), `#!/bin/sh\necho "${name} $*" >> "$FAKE_PG_LOG"\n${body}`);
    chmodSync(join(bin, "bin", name), 0o755);
  };
  script("initdb", 'mkdir -p "$2" && echo "#port = 5432" > "$2/postgresql.conf"\n');
  script("pg_ctl", "");
  return bin;
}

/** A company root in a git repository of its own. */
function repo(): string {
  const root = join(dir, "acme");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", root]);
  return root;
}

/** The cluster's `data/postmaster.pid`, as Postgres writes it: the pid first, the port fourth. */
function postmasterPid(root: string, pid: number, port: number) {
  const data = join(root, ".sanoma/postgres/data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "postgresql.conf"), `port = ${port}\n`);
  writeFileSync(join(root, ".sanoma/postgres/password"), "secret");
  writeFileSync(join(data, "postmaster.pid"), `${pid}\n${data}\n1700000000\n${port}\n\n127.0.0.1\n1 2\nready\n`);
}

/** A pid no process has: one that ran and exited. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

const listening = () =>
  new Promise<Server>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
const portOf = (server: Server) => (server.address() as { port: number }).port;

beforeEach(() => {
  // By its real path, as git names it (macOS's tmpdir is a link).
  dir = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-pg-")));
  calls = join(dir, "calls.log");
  vi.stubEnv("FAKE_PG_LOG", calls);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(pg.Client).mockReset();
  rmSync(dir, { recursive: true, force: true });
});

describe("ensurePostgres with a URL named", () => {
  it("uses one that answers as it is, and its stop does nothing", async () => {
    const log: string[] = [];
    const url = testDatabaseUrl("sanoma-pg");
    const ensured = await ensurePostgres(url, { root: dir, log: (l) => log.push(l) });
    expect(ensured).toMatchObject({ how: "answered", databaseUrl: url });
    await ensured.stop();
    expect(log).toEqual([`Postgres answers at ${masked(url)}`]);
    expect(existsSync(join(dir, ".sanoma"))).toBe(false);
  });

  it("probes the server's postgres database with the URL's own settings, so a hosted server's sslmode holds", async () => {
    stubPostgres({ up: [5432] });
    await ensurePostgres("postgresql://u:p@db.example.com:5432/neondb?sslmode=require&channel_binding=require", {
      root: dir,
    });
    expect(vi.mocked(pg.Client).mock.calls.at(-1)?.[0]).toMatchObject({
      connectionString: "postgresql://u:p@db.example.com:5432/postgres?sslmode=require&channel_binding=require",
    });
  });

  it("throws when nothing answers, naming it without its password, and starts nothing", async () => {
    stubPostgres();
    await expect(ensurePostgres("postgresql://u:p@10.255.255.1:5432/x", { root: dir, bin: fakeBin() })).rejects.toThrow(
      "nothing answers at postgresql://u:***@10.255.255.1:5432/x; start Postgres there, or remove SANOMA_DATABASE_URL to use the embedded Postgres",
    );
    expect(ran()).toEqual([]);
  });

  it("takes it unprobed with start false, as a deployment's worker or app does", async () => {
    stubPostgres();
    await expect(
      ensurePostgres("postgresql://u:p@10.255.255.1:5432/x", { root: dir, start: false }),
    ).resolves.toMatchObject({
      how: "answered",
      databaseUrl: "postgresql://u:p@10.255.255.1:5432/x",
    });
    expect(vi.mocked(pg.Client)).not.toHaveBeenCalled();
  });

  it("says where the records of the old default are, when it is that URL", async () => {
    stubPostgres();
    await expect(ensurePostgres(OLD_DEFAULT_URL, { root: dir })).rejects.toThrow(
      "nothing answers at postgresql://postgres:***@localhost:5433/sanoma; earlier versions started this in Docker: " +
        "start that container to keep its records, or remove SANOMA_DATABASE_URL from .env to use the embedded Postgres",
    );
  });

  it("knows the old default as the runtime's default", () => {
    expect(OLD_DEFAULT_URL).toBe(resolveDatabaseUrl({}, {}));
  });
});

describe("ensurePostgres with none named: the company's own", () => {
  it("creates the cluster in .sanoma/postgres, starts it detached, then stops it once nobody else is connected", async () => {
    stubPostgres();
    const root = repo();
    const log: string[] = [];
    const ensured = await ensurePostgres(undefined, { root, bin: fakeBin(), log: (l) => log.push(l) });

    const cluster = join(root, ".sanoma/postgres");
    const password = readFileSync(join(cluster, "password"), "utf8");
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    expect(statSync(join(cluster, "password")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(cluster, ".gitignore"), "utf8")).toBe("*\n");
    const conf = readFileSync(join(cluster, "data/postgresql.conf"), "utf8");
    const port = Number(/^port = (\d+)$/m.exec(conf)![1]);
    expect(conf).toContain("listen_addresses = '127.0.0.1'\n");
    expect(conf).toContain("unix_socket_directories = ''\n");
    expect(ensured).toMatchObject({
      how: "created",
      databaseUrl: `postgresql://postgres:${password}@127.0.0.1:${port}/sanoma`,
    });
    expect(existsSync(join(cluster, "data.tmp"))).toBe(false);
    expect(existsSync(join(cluster, "starting"))).toBe(false);
    expect(ran()).toEqual([
      `initdb -D ${cluster}/data.tmp -U postgres --pwfile=${cluster}/password --auth=scram-sha-256 --encoding=UTF8 ` +
        "--locale=C --locale-provider=builtin --builtin-locale=C.UTF-8",
      `pg_ctl start -D ${cluster}/data -l ${cluster}/server.log -w -t 60`,
    ]);
    expect(log).toEqual([
      `starting Postgres in ${cluster} on port ${port}`,
      `created Postgres in ${cluster}: the company's records live there, and deleting it deletes them`,
    ]);

    await ensured.stop();
    expect(ran().at(-1)).toBe(`pg_ctl stop -D ${cluster}/data -m fast -w`);
    expect(log.at(-1)).toBe(`stopped Postgres in ${cluster}`);

    // Made already: started, on the same port and password.
    const again = await ensurePostgres(undefined, { root, bin: fakeBin() });
    expect(again).toMatchObject({ how: "started", databaseUrl: ensured.databaseUrl });
    expect(ran().filter((call) => call.startsWith("initdb"))).toHaveLength(1);
  });

  it("leaves the cluster up when another client is connected", async () => {
    stubPostgres({ others: 2 });
    const root = repo();
    const log: string[] = [];
    const ensured = await ensurePostgres(undefined, { root, bin: fakeBin(), log: (l) => log.push(l) });
    await ensured.stop();
    expect(ran().some((call) => call.startsWith("pg_ctl stop"))).toBe(false);
    expect(log.at(-1)).toBe(`leaving Postgres running in ${root}/.sanoma/postgres: 2 other connections`);
  });

  it("is the main checkout's for a worktree of the repo, the company's directory in it", async () => {
    const root = repo();
    const env = { ...process.env, ...gitIdentity() };
    execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "first"], { cwd: root, env });
    mkdirSync(join(root, "ops"));
    const draft = join(root, ".sanoma/drafts/d1");
    execFileSync("git", ["worktree", "add", "--quiet", draft], { cwd: root, env });
    mkdirSync(join(draft, "ops"));
    expect(await clusterDir(draft)).toBe(join(root, ".sanoma/postgres"));
    expect(await clusterDir(join(draft, "ops"))).toBe(join(root, "ops/.sanoma/postgres"));
    // Outside git: the root's own.
    expect(await clusterDir(dir)).toBe(join(dir, ".sanoma/postgres"));
  });

  it("uses a cluster whose postmaster runs and answers, and leaves it up", async () => {
    const root = repo();
    postmasterPid(root, process.pid, 54321);
    stubPostgres({ up: [54321] });
    const ensured = await ensurePostgres(undefined, { root, bin: fakeBin(), start: false });
    expect(ensured).toMatchObject({
      how: "answered",
      databaseUrl: "postgresql://postgres:secret@127.0.0.1:54321/sanoma",
    });
    await ensured.stop();
    expect(ran()).toEqual([]);
  });

  it("starts over a stale postmaster.pid: one whose process is gone left to Postgres, one whose pid another program has deleted", async () => {
    stubPostgres();
    const root = repo();
    const pid = join(root, ".sanoma/postgres/data/postmaster.pid");
    postmasterPid(root, deadPid(), 54321);
    await expect(ensurePostgres(undefined, { root, bin: fakeBin() })).resolves.toMatchObject({ how: "started" });
    expect(existsSync(pid)).toBe(true);

    rmSync(calls);
    // This test's own pid: alive, and no postgres.
    postmasterPid(root, process.pid, 54321);
    await expect(ensurePostgres(undefined, { root, bin: fakeBin() })).resolves.toMatchObject({ how: "started" });
    expect(existsSync(pid)).toBe(false);
  });

  it("moves to a free port when another process holds the cluster's", async () => {
    stubPostgres();
    const root = repo();
    postmasterPid(root, deadPid(), 1);
    const server = await listening();
    try {
      const conf = join(root, ".sanoma/postgres/data/postgresql.conf");
      writeFileSync(conf, `#port = 5432\nport = ${portOf(server)}\n`);
      const { databaseUrl } = await ensurePostgres(undefined, { root, bin: fakeBin() });
      const port = Number(new URL(databaseUrl).port);
      expect(port).not.toBe(portOf(server));
      expect(readFileSync(conf, "utf8")).toBe(`#port = 5432\nport = ${port}\n`);
    } finally {
      server.close();
    }
  });

  it("waits while another launcher holds the starting lock, then uses the cluster it started; takes over a stale lock", async () => {
    const root = repo();
    const lock = join(root, ".sanoma/postgres/starting");
    mkdirSync(join(root, ".sanoma/postgres"), { recursive: true });
    writeFileSync(lock, String(process.pid));
    stubPostgres({ up: [54321] });
    const ensuring = ensurePostgres(undefined, { root, bin: fakeBin() });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(existsSync(lock)).toBe(true);
    // The other launcher's cluster answers, and it lets go.
    postmasterPid(root, process.pid, 54321);
    rmSync(lock);
    await expect(ensuring).resolves.toMatchObject({ how: "answered" });
    expect(ran()).toEqual([]);

    rmSync(join(root, ".sanoma/postgres/data"), { recursive: true });
    writeFileSync(lock, String(deadPid()));
    await expect(ensurePostgres(undefined, { root, bin: fakeBin() })).resolves.toMatchObject({ how: "created" });
    expect(existsSync(lock)).toBe(false);
  });

  it("only finds a running cluster with start false, and starts none as root", async () => {
    stubPostgres();
    const root = repo();
    const finding = ensurePostgres(undefined, { root, bin: fakeBin(), start: false });
    await expect(finding).rejects.toThrow(UsageError);
    await expect(finding).rejects.toThrow(
      `no Postgres runs in ${await clusterDir(root)}: set SANOMA_DATABASE_URL, or run \`sanoma\``,
    );
    vi.spyOn(process, "getuid").mockReturnValue(0);
    await expect(ensurePostgres(undefined, { root, bin: fakeBin() })).rejects.toThrow(
      "PostgreSQL refuses to run as root, so sanoma cannot start the company's own: set SANOMA_DATABASE_URL",
    );
    expect(ran()).toEqual([]);
  });
});

describe("masked", () => {
  it("hides the password", () => {
    expect(masked("postgresql://a:secret@h:1/d")).toBe("postgresql://a:***@h:1/d");
    expect(masked("postgresql://h/d")).toBe("postgresql://h/d");
  });
});
