import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { eachLine, eventOf, listeningUrlOf } from "./events.ts";

/** Where a line came from: one of the child's streams. */
export type Stream = "stdout" | "stderr";

/** How a child ended: its exit code, or the signal that ended it. */
export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** The exit code a launcher ends with for how it was called or what it found: a config error. */
export const USAGE_EXIT = 2;

/** How long `stop` waits after SIGTERM before SIGKILL. */
const KILL_AFTER_MS = 10_000;

export interface Group {
  /** Resolves once the child exited, or could not start (code null, no signal). */
  exited: Promise<Exit>;
  /**
   * Closes the child's stdin (a launcher with events stops on it), sends SIGTERM to its process
   * group, and SIGKILL after `killAfterMs`; resolves once it exited, at once if it has.
   */
  stop(): Promise<void>;
}

export interface GroupOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  onLine: (stream: Stream, line: string) => void;
  killAfterMs?: number;
}

/** How long the shell waits, once a child exited, for the last lines it printed. */
const DRAIN_MS = 1_000;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Runs `command` in a process group of its own (`detached`), each line it prints going to
 * `onLine`. Once the child exits, for any reason, whatever it left in its group (a worker, a dev
 * server holding the port) gets SIGTERM, and SIGKILL when still there at the deadline; `exited`
 * resolves after that, and after the last lines it printed (or `DRAIN_MS`, when a process outside
 * the group still holds its output open).
 */
export function spawnGroup(
  command: string,
  args: readonly string[],
  { cwd, env, onLine, killAfterMs = KILL_AFTER_MS }: GroupOptions,
): Group {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const drained = Promise.all(
    (["stdout", "stderr"] as const).map(
      (stream) => new Promise<void>((done) => eachLine(child[stream]!, (line) => onLine(stream, line), done)),
    ),
  );
  // A child that has stopped reading its stdin must not take this process down with EPIPE.
  child.stdin!.on("error", () => {});
  /** Sends `name` (0: none, a check) to the child's group; false when the group is gone. */
  const signal = (name: NodeJS.Signals | 0) => {
    try {
      process.kill(-child.pid!, name);
      return true;
    } catch {
      return false;
    }
  };
  /** When the group gets SIGKILL: set by `stop`, else the deadline after the child exits. */
  let killAt: number | undefined;
  const exited = new Promise<Exit>((done) => {
    child.once("exit", async (code, exitSignal) => {
      killAt ??= Date.now() + killAfterMs;
      signal("SIGTERM");
      while (signal(0) && Date.now() < killAt) await sleep(25);
      signal("SIGKILL");
      await Promise.race([drained, sleep(DRAIN_MS)]);
      done({ code, signal: exitSignal });
    });
    child.once("error", (err) => {
      onLine("stderr", `could not start ${command}: ${err.message}`);
      done({ code: null, signal: null });
    });
  });
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (child.pid === undefined) return exited.then(() => {});
    stopping ??= (async () => {
      killAt ??= Date.now() + killAfterMs;
      child.stdin!.end();
      signal("SIGTERM");
      const kill = setTimeout(() => signal("SIGKILL"), Math.max(0, killAt - Date.now()));
      await exited;
      clearTimeout(kill);
    })();
    return stopping;
  };
  return { exited, stop };
}

/**
 * The launcher's script in the company's install: `node_modules/sanoma`'s `bin`, as the `sanoma`
 * the repo installed is the one that serves it (the launcher's own `serveStarted` does the same).
 */
export function launcherOf(repo: string): string {
  const dir = join(repo, "node_modules", "sanoma");
  if (!existsSync(join(dir, "package.json"))) {
    throw new Error(`${repo} has no node_modules/sanoma: its install did not finish`);
  }
  return binOf(dir, "sanoma");
}

/** The script a package's `bin` names `name` (or its only one, a string), resolved in the package. */
export function binOf(dir: string, name: string): string {
  const { bin } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const script = typeof bin === "string" ? bin : bin?.[name];
  if (!script) throw new Error(`${dir}/package.json names no ${name} bin`);
  return resolve(dir, script);
}

/** Where a computer keeps what the shell may need beyond its own shims: git, gh, Docker. */
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * The launcher's environment: this process's, with `SANOMA_EVENTS=1` (JSON event lines), the
 * company's port, and PATH starting at the shims (`writeShims`), then the system's, then where
 * Homebrew installs (an app started from the Finder gets a short PATH). The port wins over the
 * company's `.env`, which the launcher loads without overriding what is set.
 */
export function launcherEnv(base: NodeJS.ProcessEnv, bin: string, port: number): NodeJS.ProcessEnv {
  const path = [bin, ...(base.PATH ?? "").split(delimiter), ...EXTRA_PATH].filter(Boolean);
  return { ...base, SANOMA_EVENTS: "1", SANOMA_APP_PORT: String(port), PATH: [...new Set(path)].join(delimiter) };
}

export interface LaunchOptions extends GroupOptions {
  /** The Node that runs the launcher. */
  node: string;
  /** The launcher's script (`launcherOf`). */
  cli: string;
  /** The port the app is to listen on, polled at `/healthz` for a launcher without events. */
  port: number;
  /** How often to poll; default 500 ms. */
  pollMs?: number;
}

export interface Launched extends Group {
  /**
   * Where the app is: from the `ready` event, else the launcher's "at <url>; ctrl-c to stop" line,
   * else the first answer from `/healthz` on the port. Rejects when the launcher exits first, with
   * the last `error` event's message when there was one.
   */
  ready: Promise<string>;
}

/** Starts the company's launcher in `cwd` with `node`, in a group of its own (`spawnGroup`). */
export function launch({ node, cli, port, pollMs = 500, ...options }: LaunchOptions): Launched {
  let lastError: string | undefined;
  // Only the first settles it: an event, a line or /healthz, else the exit.
  const settle = Promise.withResolvers<string>();
  settle.promise.catch(() => {});
  const done = (url: string) => {
    clearInterval(poll);
    settle.resolve(url);
  };
  const group = spawnGroup(node, [cli], {
    ...options,
    onLine(stream, line) {
      options.onLine(stream, line);
      if (stream !== "stdout") return;
      const event = eventOf(line);
      if (event?.event === "error") lastError = event.message;
      const url = event?.event === "ready" ? event.url : listeningUrlOf(line);
      if (url) done(url);
    },
  });
  const app = `http://127.0.0.1:${port}`;
  let asking = false;
  const poll = setInterval(() => {
    if (asking) return;
    asking = true;
    fetch(`${app}/healthz`, { signal: AbortSignal.timeout(2_000) })
      // The event or the line, which name the app's own host, follow at once: they win for a second.
      .then((res) => res.ok && setTimeout(() => done(app), 1_000))
      .catch(() => {})
      .finally(() => (asking = false));
  }, pollMs);
  void group.exited.then(({ code, signal }) => {
    clearInterval(poll);
    const how = signal ? `was stopped (${signal})` : `exited with code ${code}`;
    settle.reject(new Error(lastError ?? `the launcher ${how} before the app answered`));
  });
  return { ...group, ready: settle.promise };
}
