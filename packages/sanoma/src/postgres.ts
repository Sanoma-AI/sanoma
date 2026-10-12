import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "pg";

export interface EnsuredPostgres {
  /** Postgres answered at the URL already; or the named container was running or stopped and was reused; or it was created. */
  how: "answered" | "reused" | "created";
  /** The Docker container, when one was reused or created. */
  container?: string;
}

export interface EnsurePostgresOptions {
  /** Names the container: `sanoma-<appName>-postgres`. */
  appName: string;
  /** Receives a line per step. */
  log?: (line: string) => void;
  /** Runs `docker <args>` and resolves its stdout; rejects with `code: "ENOENT"` when Docker is not installed. For tests. */
  docker?: (args: string[]) => Promise<string>;
  /** Whether Postgres answers at the URL; throws for a server that answers with an error, such as a refused password. For tests. */
  probe?: (url: URL) => Promise<boolean>;
  /** How long one probe waits for a connection. Default 2 seconds. */
  probeTimeoutMs?: number;
  /** How long to wait for Postgres in a container to answer. Default 60 seconds. */
  waitMs?: number;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const runDocker = async (args: string[]): Promise<string> => (await promisify(execFile)("docker", args)).stdout;

/** The URL with its password hidden, for a message. */
export function masked(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (url.password) url.password = "***";
  return url.toString();
}

/**
 * Makes sure Postgres answers at `databaseUrl`, starting it in Docker when nothing does and the
 * host is this machine. It probes the server (`SELECT 1` on the `postgres` database, with the
 * URL's user and password); an answer is enough. Nothing answering at a loopback host means
 * Docker: the container `sanoma-<appName>-postgres` is started when it exists and stopped,
 * created from `postgres:17` on the URL's port, user, password and database when it does not,
 * and left as it is when it runs already; then the probe is repeated until it answers. A
 * container is never removed. Throws when the server answers with an error (a wrong password),
 * when nothing answers at another host, when Docker is not installed, and when the container
 * does not answer within `waitMs`.
 */
export async function ensurePostgres(databaseUrl: string, options: EnsurePostgresOptions): Promise<EnsuredPostgres> {
  const { appName, log = () => {}, docker = runDocker, probeTimeoutMs = 2000, waitMs = 60_000 } = options;
  const probe = options.probe ?? ((url: URL) => answers(url, probeTimeoutMs));
  const url = new URL(databaseUrl);
  if (await probe(url)) return { how: "answered" };
  if (!LOOPBACK.has(url.hostname)) {
    throw new Error(`nothing answers at ${masked(databaseUrl)}; start Postgres or set SANOMA_DATABASE_URL`);
  }
  if (!url.password) {
    throw new Error(`nothing answers at ${masked(databaseUrl)}, and the URL has no password to create Postgres with`);
  }

  const container = `sanoma-${slug(appName)}-postgres`;
  const run = async (args: string[]) => {
    try {
      return (await docker(args)).trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("docker is not installed; start Postgres and set SANOMA_DATABASE_URL", { cause: err });
      }
      throw err;
    }
  };
  const state = await run(["inspect", "-f", "{{.State.Running}}", container]).catch((err: unknown) => {
    if ((err as Error).message.includes("not installed")) throw err;
    return undefined;
  });
  let how: EnsuredPostgres["how"];
  if (state === "true") {
    log(`Postgres container ${container} is running; waiting for it to answer`);
    how = "reused";
  } else if (state === "false") {
    log(`starting Postgres container ${container}`);
    await run(["start", container]);
    how = "reused";
  } else {
    log(`creating Postgres container ${container} on port ${port(url)} (postgres:17)`);
    await run([
      "run",
      "-d",
      "--name",
      container,
      "-e",
      `POSTGRES_USER=${decodeURIComponent(url.username || "postgres")}`,
      "-e",
      `POSTGRES_PASSWORD=${decodeURIComponent(url.password)}`,
      "-e",
      `POSTGRES_DB=${decodeURIComponent(url.pathname.slice(1)) || "postgres"}`,
      "-p",
      `${port(url)}:5432`,
      "postgres:17",
    ]);
    how = "created";
  }

  const deadline = Date.now() + waitMs;
  while (!(await probe(url))) {
    if (Date.now() > deadline) {
      throw new Error(
        `Postgres in container ${container} did not answer at ${masked(databaseUrl)} within ${waitMs} ms`,
      );
    }
    await delay(500);
  }
  return { how, container };
}

const port = (url: URL) => url.port || "5432";

/** A container name from an app name: lowercase, anything but `[a-z0-9_.-]` as `-`. */
const slug = (appName: string) => appName.toLowerCase().replaceAll(/[^a-z0-9_.-]/g, "-");

/**
 * Whether a Postgres server answers at the URL's host and port, as its user: `SELECT 1` on the
 * `postgres` database. False when the connection is refused, unreachable or not answered within
 * `timeoutMs`; any other failure (a refused password, a user that does not exist) is thrown.
 */
export async function answers(url: URL, timeoutMs: number): Promise<boolean> {
  const client = new Client({
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: Number(port(url)),
    user: decodeURIComponent(url.username || "postgres"),
    password: decodeURIComponent(url.password),
    database: "postgres",
    connectionTimeoutMillis: timeoutMs,
  });
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
