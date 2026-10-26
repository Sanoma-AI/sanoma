import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Exit, type Group, launch, launcherEnv, launcherOf, spawnGroup, type Stream } from "./launcher.ts";
import { writeShims } from "./shims.ts";

export interface SessionOptions {
  /** The company's folder. */
  repo: string;
  port: number;
  /** The Node the shell ships, and the staged pnpm's script. */
  node: string;
  pnpm: string;
  /** Where the `node` and `pnpm` shims go, first on the launcher's PATH. */
  bin: string;
  /** The environment the launcher's is made from (`launcherEnv`). */
  env: NodeJS.ProcessEnv;
  /** Each line the install and the launcher print. */
  onLine: (stream: Stream, line: string) => void;
  /** What the session is doing, in a few words, for the start window. */
  onProgress: (step: string) => void;
  killAfterMs?: number;
  pollMs?: number;
}

export interface Session {
  /** Where the app is, once it answers; rejects when the session ends first. */
  ready: Promise<string>;
  /** Resolves when the session ends: the launcher exited, it failed to start, or `stop`. */
  ended: Promise<Exit & { error?: string }>;
  /** Stops whatever runs (the install or the launcher) and starts nothing more. */
  stop(): Promise<void>;
}

/**
 * Opens a company: writes the shims, runs `pnpm install --prefer-offline` in it (a failure is
 * only a warning while `node_modules/sanoma` is there), then its own launcher (`launch`).
 */
export function startSession(options: SessionOptions): Session {
  const { repo, port, node, pnpm, bin, onLine, onProgress, killAfterMs, pollMs } = options;
  let current: Group | undefined;
  let stopped = false;
  const env = launcherEnv(options.env, bin, port);
  const group = { cwd: repo, env, onLine, killAfterMs };

  const run = async (): Promise<{ ready: Promise<string>; exited: Promise<Exit> } | undefined> => {
    writeShims(bin, node, pnpm);
    onProgress("Installing packages");
    current = spawnGroup(join(bin, "pnpm"), ["install", "--prefer-offline"], group);
    const installed = await current.exited;
    if (stopped) return undefined;
    if (installed.code !== 0) {
      if (!existsSync(join(repo, "node_modules", "sanoma"))) {
        throw new Error("pnpm install failed and the company has no sanoma installed: see the log");
      }
      onLine("stderr", "warning: pnpm install failed; starting with the packages already installed");
    }
    onProgress("Starting the company");
    const launched = launch({ ...group, node, cli: launcherOf(repo), port, pollMs });
    current = launched;
    return launched;
  };

  const started = run();
  const ready = started.then((launched) => launched?.ready ?? Promise.reject(new Error("stopped")));
  ready.catch(() => {});
  const ended = started.then(
    async (launched) => (launched ? await launched.exited : { code: null, signal: null }),
    (err: unknown) => ({ code: null, signal: null, error: err instanceof Error ? err.message : String(err) }),
  );
  return {
    ready,
    ended,
    async stop() {
      stopped = true;
      await current?.stop();
      await ended;
    },
  };
}
