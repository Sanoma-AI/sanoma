import { execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "pg";
import { UsageError } from "sanoma/workflows/shared";
import { postgresBin } from "./postgres-bin.ts";
import { system32 } from "./windows.ts";

export interface EnsuredPostgres {
  /** Postgres answered (at the URL named, or the company's own, run by another launcher); or this call started the company's own; or created it first. */
  how: "answered" | "started" | "created";
  /** Where it answers: the URL named, or the company's own, `postgresql://postgres:<password>@127.0.0.1:<port>/sanoma`. */
  databaseUrl: string;
  /**
   * Stops the company's own Postgres when this call started or adopted it and no other client is connected
   * (another launcher's worker, say), saying so when one is; nothing otherwise.
   */
  stop(): Promise<void>;
}

export interface EnsurePostgresOptions {
  /** The company's root: its cluster is `.sanoma/postgres` in its main checkout (`clusterDir`). */
  root: string;
  /** Receives a line per step. */
  log?: (line: string) => void;
  /** Without it, a URL named is taken as it is, unprobed, and only a cluster of the company's own that runs already is found: a `UsageError` when none does. */
  start?: boolean;
  /**
   * For a launcher that runs on, its clients soon connected: a cluster found running is its to stop
   * too, when none is left. Not for a one-off command, which could stop one another launcher has yet
   * to connect to.
   */
  adopt?: boolean;
  /** The directory holding PostgreSQL's `bin/`; default `postgresBin()`, read only to start one. */
  bin?: string;
}

/**
 * The URL `sanoma` (through `.env`) and the runtime named by default before the launcher started
 * the company's own Postgres: the Postgres in Docker that earlier versions started there.
 */
export const OLD_DEFAULT_URL = "postgresql://postgres:dbos@localhost:5433/sanoma";

/** The `stop` of a database this call did not start. */
const noStop = async () => {};

/** How long one probe waits for a connection. */
const PROBE_TIMEOUT_MS = 2000;
/** How long `pg_ctl` waits for Postgres to accept connections once started. */
const WAIT_MS = 60_000;
/** How long a launcher waits for another to make and start the cluster: an extraction, `initdb` and a start. */
const LOCK_WAIT_MS = 5 * 60_000;

/** The URL with its password hidden, for a message. */
export function masked(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (url.password) url.password = "***";
  return url.toString();
}

/**
 * Makes sure Postgres answers. A URL named (`databaseUrl`) is probed (`SELECT 1` on the `postgres`
 * database, as its user) and used as it is, or the call throws, saying what to do. With none, the
 * company's own: a PostgreSQL 18 cluster in `clusterDir(root)` (`password`, mode 0600, `server.log`
 * and `data/`), on 127.0.0.1 alone at a port of its own, as `postgres` with the password. A
 * cluster another launcher runs is used as it is (`answered`), and with `adopt` stopped at the end
 * when no client is left on it, as a launcher that crashed left it so (on Windows, a shell's crash
 * takes the launcher with it but not `pg_ctl`'s Postgres); else, unless `start` is false, it is started (`started`), made first with `initdb` when there is no `data/` (`created`), under the
 * `starting` lock so two launchers never start it twice. Its port is rewritten when another
 * process took it. `pg_ctl` runs in a process group of its own (not on Windows: `runPg`), so a
 * terminal's ctrl-c reaches the launcher alone, which stops it last (`stop`).
 */
export async function ensurePostgres(
  databaseUrl: string | undefined,
  { root, log = () => {}, start = true, adopt = false, bin }: EnsurePostgresOptions,
): Promise<EnsuredPostgres> {
  if (databaseUrl !== undefined) {
    // A deployment's worker or app: its database's own to answer, as the runtime retries.
    if (!start) return { how: "answered", databaseUrl, stop: noStop };
    if (await answers(databaseUrl)) {
      log(`Postgres answers at ${masked(databaseUrl)}`);
      return { how: "answered", databaseUrl, stop: noStop };
    }
    throw new Error(
      `nothing answers at ${masked(databaseUrl)}; ${
        databaseUrl === OLD_DEFAULT_URL
          ? "earlier versions started this in Docker: start that container to keep its records, " +
            "or remove SANOMA_DATABASE_URL from .env to use the embedded Postgres"
          : "start Postgres there, or remove SANOMA_DATABASE_URL to use the embedded Postgres"
      }`,
    );
  }

  const cluster = paths(await clusterDir(root));
  const found = await running(cluster);
  /** What a launcher does with a cluster it did not start. */
  const answer = (url: string): EnsuredPostgres => {
    log(`Postgres answers in ${cluster.dir}, started by another launcher`);
    // Best effort: the launcher that started it may be stopping it too, and the next launch adopts
    // what stays.
    const stop = adopt
      ? () =>
          stopAlone(() => bin ?? postgresBin(), cluster, url, log).catch((err: unknown) => {
            log(`could not stop Postgres in ${cluster.dir}: ${String(err)}`);
          })
      : noStop;
    return { how: "answered", databaseUrl: url, stop };
  };
  if (found !== undefined) return answer(found);
  if (!start) {
    throw new UsageError(`no Postgres runs in ${cluster.dir}: set SANOMA_DATABASE_URL, or run \`sanoma\``);
  }
  if (process.getuid?.() === 0) {
    throw new Error(
      "PostgreSQL refuses to run as root, so sanoma cannot start the company's own: " +
        "set SANOMA_DATABASE_URL to a Postgres of your own, or run sanoma as another user",
    );
  }
  mkdirSync(cluster.dir, { recursive: true });
  // Nothing in it is the repo's, the records least of all.
  if (!existsSync(join(cluster.dir, ".gitignore"))) writeFileSync(join(cluster.dir, ".gitignore"), "*\n");
  if (cluster.dir.startsWith(join(homedir(), "Library", "Mobile Documents"))) {
    log(`warning: ${cluster.dir} is in iCloud Drive, which may sync the records while Postgres writes them`);
  }

  return locked(cluster, async () => {
    // Started meanwhile, by the launcher that held the lock.
    const meanwhile = await running(cluster);
    if (meanwhile !== undefined) return answer(meanwhile);
    const pg = bin ?? postgresBin();
    const how = existsSync(cluster.data) ? "started" : "created";
    if (how === "created") await initdb(pg, cluster);
    else if (!existsSync(cluster.password)) {
      throw new Error(`${cluster.password} is missing: it is the password of the records in ${cluster.data}`);
    } else clearStale(cluster);
    const port = await portOf(cluster);
    const url = urlOf(cluster, port);
    log(`starting Postgres in ${cluster.dir} on port ${port}`);
    await pgCtl(pg, cluster, ["start", "-D", cluster.data, "-l", cluster.log, "-w", "-t", String(WAIT_MS / 1000)]);
    // `pg_ctl -w` waited for it to accept connections.
    if (!(await answers(url))) throw new Error(`Postgres in ${cluster.dir} did not answer; see ${cluster.log}`);
    if (how === "created") {
      log(`created Postgres in ${cluster.dir}: the company's records live there, and deleting it deletes them`);
    }
    return { how, databaseUrl: url, stop: () => stopAlone(() => pg, cluster, url, log) };
  });
}

interface Cluster {
  dir: string;
  data: string;
  password: string;
  log: string;
  /** The lock held while one launcher makes and starts the cluster: its pid inside. */
  lock: string;
}

const paths = (dir: string): Cluster => ({
  dir,
  data: join(dir, "data"),
  password: join(dir, "password"),
  log: join(dir, "server.log"),
  lock: join(dir, "starting"),
});

/**
 * Where the company's own Postgres lives: `.sanoma/postgres` in the company's root as its main
 * checkout has it (the directory of git's common dir), so a worktree of the repo (a draft in
 * `.sanoma/drafts/<id>`) finds the same cluster; `root` itself outside git.
 */
export async function clusterDir(root: string): Promise<string> {
  const real = realpathSync(root);
  const [common, top] = await promisify(execFile)(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
    { cwd: real },
  ).then(
    ({ stdout }) => stdout.trim().split("\n"),
    () => [],
  );
  const main = common && top && basename(common) === ".git" ? join(dirname(common), relative(top, real)) : real;
  return join(main, ".sanoma", "postgres");
}

const urlOf = ({ password }: Cluster, port: number) =>
  `postgresql://postgres:${readFileSync(password, "utf8").trim()}@127.0.0.1:${port}/sanoma`;

/** `data/postmaster.pid`'s process (its first line) and port (its fourth), when there is one. */
function postmaster({ data }: Cluster): { file: string; pid: number; port: number } | undefined {
  const file = join(data, "postmaster.pid");
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, "utf8").split("\n");
  return { file, pid: Number(lines[0]), port: Number(lines[3]) };
}

/** The cluster's URL when its postmaster runs and answers: `postmaster.pid` names a live process, and its port answers. */
async function running(cluster: Cluster): Promise<string | undefined> {
  const pm = postmaster(cluster);
  if (!pm || !alive(pm.pid) || !pm.port || !existsSync(cluster.password)) return undefined;
  const url = urlOf(cluster, pm.port);
  return (await answers(url)) ? url : undefined;
}

/**
 * Deletes a stale `postmaster.pid` whose process is another program's now (its pid reused, after
 * a restart), which Postgres would take for a server still running. One whose process is gone is
 * left to Postgres, which replaces it once no backend of the old server holds its shared memory;
 * a Postgres that runs there but does not answer is a mistake to report, never a second server.
 */
function clearStale(cluster: Cluster): void {
  const pm = postmaster(cluster);
  if (!pm || !alive(pm.pid)) return;
  if (mayBePostgres(pm.pid)) {
    throw new Error(`Postgres (pid ${pm.pid}) may run in ${cluster.data} but does not answer; see ${cluster.log}`);
  }
  rmSync(pm.file, { force: true });
}

/**
 * Whether the process `pid` may be a Postgres server: what `ps` (on Windows, `tasklist`) says it
 * runs, or true when there is no telling, as never a second server may start on its data.
 */
export function mayBePostgres(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: (command: string, args: string[]) => { error?: Error; status: number | null; stdout: string } = (
    command,
    args,
  ) => spawnSync(command, args, { encoding: "utf8", windowsHide: true }),
): boolean {
  if (platform === "win32") {
    // One CSV line, its image name first: "postgres.exe","1234",… (or a line saying there is none).
    const list = run(system32("tasklist.exe"), ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    return Boolean(list.error) || list.status !== 0 || /^"postgres\.exe"/i.test(list.stdout.trim());
  }
  const ps = run("ps", ["-o", "comm=", "-p", String(pid)]);
  return Boolean(ps.error) || /(^|\/)postgres$/.test(ps.stdout.trim());
}

/** Whether a process runs as `pid` (another user's too). */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Runs `fn` holding the cluster's `starting` lock: the file made exclusively (`wx`), this pid in
 * it, removed after. A lock whose process is gone (or, empty, older than a few seconds) is
 * stale and taken over; a live one is waited for, up to `LOCK_WAIT_MS`.
 */
async function locked<T>(cluster: Cluster, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(cluster.lock, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let holder: string;
    let fresh: boolean;
    try {
      holder = readFileSync(cluster.lock, "utf8");
      const age = Date.now() - statSync(cluster.lock).mtimeMs;
      // Being written: its maker is between making it and writing its pid. Older than any start
      // takes: left by a crash, its pid perhaps another process's since.
      fresh = !holder && age < 5000;
      if (age > LOCK_WAIT_MS) holder = "";
    } catch {
      continue; // Removed meanwhile.
    }
    if (!fresh && !alive(Number(holder))) {
      rmSync(cluster.lock, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`another sanoma (pid ${holder}) is still starting Postgres in ${cluster.dir}`);
    }
    await delay(200);
  }
  try {
    return await fn();
  } finally {
    rmSync(cluster.lock, { force: true });
  }
}

/**
 * Makes the cluster: `initdb` into `data.tmp` (the password made first when there is none: 24
 * random bytes, hex), as `postgres` with that password over SCRAM, UTF-8 with the builtin
 * C.UTF-8 locale (and C for the rest, whatever this machine's `LANG`); then on 127.0.0.1 alone,
 * at a free port, with no Unix socket; renamed to `data` once whole.
 */
async function initdb(bin: string, cluster: Cluster): Promise<void> {
  if (!existsSync(cluster.password)) {
    writeFileSync(cluster.password, randomBytes(24).toString("hex"), { mode: 0o600 });
  }
  const temp = `${cluster.data}.tmp`;
  rmSync(temp, { recursive: true, force: true });
  await runPg(bin, "initdb", cluster, [
    "-D",
    temp,
    "-U",
    "postgres",
    `--pwfile=${cluster.password}`,
    "--auth=scram-sha-256",
    "--encoding=UTF8",
    "--locale=C",
    "--locale-provider=builtin",
    "--builtin-locale=C.UTF-8",
  ]);
  appendFileSync(
    join(temp, "postgresql.conf"),
    `\n# sanoma\nlisten_addresses = '127.0.0.1'\nport = ${await freePort()}\nunix_socket_directories = ''\n`,
  );
  renameSync(temp, cluster.data);
}

/** The cluster's port (`port = …` in `postgresql.conf`), rewritten to a free one when another process holds it. */
async function portOf(cluster: Cluster): Promise<number> {
  const conf = join(cluster.data, "postgresql.conf");
  const text = readFileSync(conf, "utf8");
  const set = [...text.matchAll(/^port = (\d+)$/gm)].at(-1);
  if (set && !(await taken(Number(set[1])))) return Number(set[1]);
  const port = await freePort();
  writeFileSync(conf, set ? text.replaceAll(/^port = \d+$/gm, `port = ${port}`) : `${text}\nport = ${port}\n`);
  return port;
}

/** Whether something listens on 127.0.0.1 at `port`. */
const taken = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(false)));
  });

/** A port nothing listens on at 127.0.0.1 now. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

/**
 * Stops the cluster (`pg_ctl stop -m fast`) unless a client but this one is connected: then it
 * stays up for them, and says so. A cluster that no longer answers is left alone.
 */
async function stopAlone(bin: () => string, cluster: Cluster, databaseUrl: string, log: (line: string) => void) {
  const client = serverClient(databaseUrl);
  let others: number;
  try {
    await client.connect();
    const count = async () =>
      (
        await client.query<{ others: number }>(
          "SELECT count(*)::int AS others FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()",
        )
      ).rows[0]!.others;
    // The worker's and the app's backends end a moment after their pools close: a second for them.
    others = await count();
    for (let i = 0; others > 0 && i < 5; i++) {
      await delay(200);
      others = await count();
    }
  } catch (err) {
    if (isSilent(err)) return;
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
  if (others > 0) {
    log(`leaving Postgres running in ${cluster.dir}: ${others} other connection${others === 1 ? "" : "s"}`);
    return;
  }
  await pgCtl(bin(), cluster, ["stop", "-D", cluster.data, "-m", "fast", "-w"]);
  log(`stopped Postgres in ${cluster.dir}`);
}

const pgCtl = (bin: string, cluster: Cluster, args: string[]) => runPg(bin, "pg_ctl", cluster, args);

/**
 * Runs PostgreSQL's `program` from `bin`, in a process group of its own (`pg_ctl start` leaves
 * the server in it), its output appended to `pg_ctl.log`; throws, with its and the server's log's
 * last lines, when it fails. Not `server.log` itself, as `pg_ctl -l` on Windows starts the server
 * through `cmd`, whose redirect cannot open a file another process has open for writing. Windows
 * has no groups, and `detached` there leaves it no console, so the `cmd` and the `postgres` it
 * starts would each open a window; it shares this process's, hidden under the desktop shell
 * (`windowsHide`).
 */
async function runPg(bin: string, program: string, cluster: Cluster, args: string[]): Promise<void> {
  const log = join(cluster.dir, "pg_ctl.log");
  const out = openSync(log, "a");
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(join(bin, "bin", program), args, {
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", out, out],
      });
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (code === 0) return;
    const ends = [log, cluster.log]
      .filter((file) => existsSync(file))
      .map((file) => {
        const tail = readFileSync(file, "utf8").trimEnd().split("\n").slice(-5).join("\n");
        return `the end of ${file}:\n${tail}`;
      });
    throw new Error(`${program} ${args[0]} failed (exit ${code}); ${ends.join("\n")}`);
  } finally {
    closeSync(out);
  }
}

/**
 * A client of the server's `postgres` database: the URL as given but for its database, so its
 * query (`sslmode=require` on a hosted server) stays. Not connected yet.
 */
function serverClient(databaseUrl: string): Client {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return new Client({ connectionString: url.toString(), connectionTimeoutMillis: PROBE_TIMEOUT_MS });
}

/**
 * Whether a Postgres server answers at the URL, with all its settings (user, `sslmode` and the
 * rest of its query): `SELECT 1` on the `postgres` database. False when the connection is refused, unreachable or not answered within
 * `PROBE_TIMEOUT_MS`; any other failure (a refused password, a user that does not exist) is thrown.
 */
async function answers(databaseUrl: string): Promise<boolean> {
  const client = serverClient(databaseUrl);
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch (err) {
    if (isSilent(err)) return false;
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Socket errors, and Postgres's `cannot_connect_now` (57P03): "the database system is starting up". */
const SILENT = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "57P03"]);

/**
 * A connection nothing answered yet: refused, unreachable, timed out (pg's own timeout error
 * has no code), closed while the server starts, or refused by a server still starting.
 */
function isSilent(err: unknown): boolean {
  const errors = err instanceof AggregateError ? err.errors : [err];
  return errors.every((e) => {
    const { code, message } = e as NodeJS.ErrnoException;
    return (code !== undefined && SILENT.has(code)) || /timeout|terminated unexpectedly/i.test(message ?? "");
  });
}
