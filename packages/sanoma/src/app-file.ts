import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, isLoopback } from "sanoma/workflows/shared";

// Only Node's modules and sanoma/workflows/shared: `sanoma` imports this when its app listens, and
// `sanoma call` to find that app, neither of which may load the worker or the app for it.

/** Where a running app says where it listens, under the directory it runs in: `{ url, pid }`. */
export const APP_FILE = ".sanoma/app.json";

/** What `.sanoma/app.json` holds: the app's URL, and the process serving it. */
interface RunningApp {
  url: string;
  pid: number;
}

/**
 * Writes `<cwd>/.sanoma/app.json` naming `url` and this process (written beside it and renamed
 * into place, so a reader never sees half of it), for `sanoma call` and `sanoma describe` to find
 * the app. Returns what removes it again, once, and only while it still names this process (a
 * later `sanoma` in the same directory may have written its own); it is removed at this process's
 * exit too. A file it cannot write is logged and left: the commands fall back to the address in
 * the environment.
 */
export function recordApp(cwd: string, url: string, log: (line: string) => void): () => void {
  const file = join(cwd, APP_FILE);
  const app: RunningApp = { url, pid: process.pid };
  const partial = `${file}.${process.pid}`;
  try {
    mkdirSync(join(cwd, ".sanoma"), { recursive: true });
    writeFileSync(partial, `${JSON.stringify(app)}\n`);
    renameSync(partial, file);
  } catch (err) {
    rmSync(partial, { force: true });
    log(`sanoma: could not write ${APP_FILE}: ${errorMessage(err)}`);
    return () => {};
  }
  let done = false;
  const forget = () => {
    if (done) return;
    done = true;
    process.off("exit", forget);
    try {
      if (readApp(file)?.pid === process.pid) rmSync(file, { force: true });
    } catch {
      // Left behind, it names a process that is gone: a reader ignores it.
    }
  };
  process.on("exit", forget);
  return forget;
}

/**
 * The app `<cwd>/.sanoma/app.json` names, when the process it names still runs (as the company's
 * own Postgres is found by its `postmaster.pid`) and its URL is an http(s) one on this machine
 * (`isLoopback`), as only the app's own listen address ever is there; undefined when there is none,
 * it is not one, or its process is gone (a `sanoma` that crashed leaves it behind). A pid reused by
 * another process since is taken as alive: the call then finds nothing at that address and says so.
 */
export function runningApp(cwd: string): RunningApp | undefined {
  const app = readApp(join(cwd, APP_FILE));
  return app && onThisMachine(app.url) && alive(app.pid) ? app : undefined;
}

function onThisMachine(url: string): boolean {
  const parsed = URL.parse(url);
  return !!parsed && (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopback(parsed.hostname);
}

function readApp(file: string): RunningApp | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { url, pid } = parsed as Partial<RunningApp>;
  return typeof url === "string" && typeof pid === "number" ? { url, pid } : undefined;
}

/** Whether a process runs as `pid` (another user's too): `postgres.ts` asks it of its postmaster too. */
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
