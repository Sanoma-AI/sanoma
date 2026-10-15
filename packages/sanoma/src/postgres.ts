import { execFile } from "node:child_process";
import { isLoopback } from "@sanoma-ai/workflows/shared";
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
  /** Receives a line per step, and one saying how Postgres was made to answer. */
  log?: (line: string) => void;
}

/** How long one probe waits for a connection. */
const PROBE_TIMEOUT_MS = 2000;
/** How long Postgres in a container has to answer. */
const WAIT_MS = 60_000;

/** The URL with its password hidden, for a message. */
export function masked(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (url.password) url.password = "***";
  return url.toString();
}

/** `docker <args>`, its stdout trimmed: the one place the bin runs Docker. */
const docker = (args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile("docker", args, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim()))),
  );

/**
 * Makes sure Postgres answers at `databaseUrl`, starting it in Docker when nothing does and the
 * host is this machine (`isLoopback`). It probes the server (`SELECT 1` on the `postgres`
 * database, with the URL's user and password); an answer is enough. Nothing answering at a
 * loopback host means Docker: the container `sanoma-<appName>-postgres` is started when it
 * exists and stopped, created from `postgres:17` on the URL's port, user, password and database
 * when it does not, and left as it is when it runs already; then the probe is repeated until it
 * answers. A container is never removed. Throws when the server answers with an error (a wrong
 * password), when nothing answers at another host, when Docker is not installed, and when the
 * container does not answer within a minute.
 */
export async function ensurePostgres(
  databaseUrl: string,
  { appName, log = () => {} }: EnsurePostgresOptions,
): Promise<EnsuredPostgres> {
  const url = new URL(databaseUrl);
  if (await answers(url, PROBE_TIMEOUT_MS)) {
    log(`Postgres answers at ${masked(databaseUrl)}`);
    return { how: "answered" };
  }
  if (!isLoopback(url.hostname)) {
    throw new Error(`nothing answers at ${masked(databaseUrl)}; start Postgres or set SANOMA_DATABASE_URL`);
  }
  if (!url.password) {
    throw new Error(`nothing answers at ${masked(databaseUrl)}, and the URL has no password to create Postgres with`);
  }

  const container = `sanoma-${slug(appName)}-postgres`;
  let state: string | undefined;
  try {
    state = await docker(["inspect", "-f", "{{.State.Running}}", container]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("docker is not installed; start Postgres and set SANOMA_DATABASE_URL", { cause: err });
    }
    // No such container.
  }
  let how: EnsuredPostgres["how"];
  if (state === "true") {
    log(`Postgres container ${container} is running; waiting for it to answer`);
    how = "reused";
  } else if (state === "false") {
    log(`starting Postgres container ${container}`);
    await docker(["start", container]);
    how = "reused";
  } else {
    log(`creating Postgres container ${container} on port ${port(url)} (postgres:17)`);
    await docker([
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

  const deadline = Date.now() + WAIT_MS;
  while (!(await answers(url, PROBE_TIMEOUT_MS))) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Postgres in container ${container} did not answer at ${masked(databaseUrl)} within ${WAIT_MS} ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  log(`Postgres ${how} in Docker: container ${container}`);
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
