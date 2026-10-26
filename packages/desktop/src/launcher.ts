import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { eachLine, eventOf, listeningUrlOf, type Ready } from "./events.ts";

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
export const KILL_AFTER_MS = 10_000;

export interface Group {
  child: ChildProcess;
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

/**
 * Runs `command` in a process group of its own (`detached`), so that `stop` reaches everything it
 * starts that stays in the group, each line it prints going to `onLine`.
 */
export function spawnGroup(
  command: string,
  args: readonly string[],
  { cwd, env, onLine, killAfterMs = KILL_AFTER_MS }: GroupOptions,
): Group {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  eachLine(child.stdout!, (line) => onLine("stdout", line));
  eachLine(child.stderr!, (line) => onLine("stderr", line));
  // A child that has stopped reading its stdin must not take this process down with EPIPE.
  child.stdin!.on("error", () => {});
  const exited = new Promise<Exit>((done) => {
    child.once("exit", (code, signal) => done({ code, signal }));
    child.once("error", (err) => {
      onLine("stderr", `could not start ${command}: ${err.message}`);
      done({ code: null, signal: null });
    });
  });
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, name);
    } catch {
      // The group is gone already.
    }
  };
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return exited.then(() => {});
    stopping ??= (async () => {
      child.stdin!.end();
      signal("SIGTERM");
      const kill = setTimeout(() => signal("SIGKILL"), killAfterMs);
      await exited;
      clearTimeout(kill);
    })();
    return stopping;
  };
  return { child, exited, stop };
}

/**
 * The launcher's script in the company's install: `node_modules/sanoma`'s `bin`, as the `sanoma`
 * the repo installed is the one that serves it (the launcher's own `serveStarted` does the same).
 */
export function launcherOf(repo: string): string {
  const dir = join(repo, "node_modules", "sanoma");
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) throw new Error(`${repo} has no node_modules/sanoma: its install did not finish`);
  const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: string | Record<string, string> };
  const script = typeof bin === "string" ? bin : bin?.sanoma;
  if (!script) throw new Error(`${manifest} names no sanoma bin`);
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
  ready: Promise<Ready>;
}

/** Starts the company's launcher in `cwd` with `node`, in a group of its own (`spawnGroup`). */
export function launch({ node, cli, port, pollMs = 500, ...options }: LaunchOptions): Launched {
  let lastError: string | undefined;
  const settle = Promise.withResolvers<Ready>();
  const ready = settle.promise;
  ready.catch(() => {});
  let isReady = false;
  const done = (value: Ready) => {
    if (isReady) return;
    isReady = true;
    clearInterval(poll);
    settle.resolve(value);
  };
  const group = spawnGroup(node, [cli], {
    ...options,
    onLine(stream, line) {
      options.onLine(stream, line);
      if (stream !== "stdout") return;
      const event = eventOf(line);
      if (event?.event === "ready") done({ url: event.url, sites: event.sites });
      else if (event?.event === "error") lastError = event.message;
      else {
        const url = listeningUrlOf(line);
        if (url) done({ url, sites: {} });
      }
    },
  });
  const healthz = `http://127.0.0.1:${port}/healthz`;
  let asking = false;
  const poll = setInterval(() => {
    if (asking) return;
    asking = true;
    fetch(healthz, { signal: AbortSignal.timeout(2_000) })
      .then((res) => res.ok && done({ url: `http://127.0.0.1:${port}`, sites: {} }))
      .catch(() => {})
      .finally(() => (asking = false));
  }, pollMs);
  void group.exited.then(({ code, signal }) => {
    clearInterval(poll);
    if (isReady) return;
    const how = signal ? `was stopped (${signal})` : `exited with code ${code}`;
    settle.reject(new Error(lastError ?? `the launcher ${how} before the app answered`));
  });
  return { ...group, ready };
}
