import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, type FSWatcher, mkdirSync, readdirSync, realpathSync, watch } from "node:fs";
import { dirname, join, sep } from "node:path";
import { createInterface } from "node:readline";

/*
 * Dev mode: when the repo's `@sanoma/workflows` resolves into a sanoma checkout (a `pnpm link`,
 * or `SANOMA_DEV_REPO`), `sanoma` builds that checkout's linked packages as they change and
 * restarts itself when one's `dist/` does.
 */

/** Whether a path is inside some `node_modules` directory. */
const installed = (path: string) => path.split(sep).includes("node_modules");

/**
 * The sanoma checkout the repo's `@sanoma/workflows` is linked from: `SANOMA_DEV_REPO` when
 * set, else the directory two above where `node_modules/@sanoma/workflows` really is (its
 * `packages/workflows`), when that is outside any `node_modules`. Undefined for an installed
 * package, and when there is none.
 */
export function devRepo(cwd: string): string | undefined {
  if (process.env.SANOMA_DEV_REPO) return process.env.SANOMA_DEV_REPO;
  const link = join(cwd, "node_modules", "@sanoma", "workflows");
  if (!existsSync(link)) return undefined;
  const real = realpathSync(link);
  return installed(real) ? undefined : dirname(dirname(real));
}

export interface LinkedPackage {
  /** The npm name, such as `@sanoma/workflows`. */
  name: string;
  /** Where it really is: its directory in the checkout. */
  dir: string;
  /** Whether it is built with vite too (`vite.config.ts`), as the app is. */
  vite: boolean;
}

/**
 * Every package under the repo's `node_modules/@sanoma/`, and `node_modules/sanoma`, that is
 * linked from outside any `node_modules`: the ones a `pnpm link` points into a checkout.
 */
export function linkedPackages(cwd: string): LinkedPackage[] {
  const modules = join(cwd, "node_modules");
  const scoped = join(modules, "@sanoma");
  const candidates = [
    ...(existsSync(scoped) ? readdirSync(scoped).map((name) => [`@sanoma/${name}`, join(scoped, name)]) : []),
    ["sanoma", join(modules, "sanoma")],
  ] as const;
  const linked: LinkedPackage[] = [];
  for (const [name, path] of candidates) {
    if (!existsSync(path)) continue;
    const dir = realpathSync(path);
    if (installed(dir)) continue;
    linked.push({ name, dir, vite: existsSync(join(dir, "vite.config.ts")) });
  }
  return linked;
}

export interface SuperviseOptions {
  /** Starts the child; called again after each restart. */
  spawn: () => ChildProcess;
  /** Directories to watch, recursively; each is created when missing. */
  watch: string[];
  /** How long after the last change to wait before restarting. Default 750 ms. */
  debounceMs?: number;
  log?: (line: string) => void;
}

/**
 * Runs the child and restarts it when anything under a watched directory changes: after
 * `debounceMs` of quiet, SIGTERM, up to 5 seconds for it to exit, then SIGKILL, then `spawn`
 * again. `stop` stops watching and stops the child the same way.
 */
export function supervise({ spawn: start, watch: dirs, debounceMs = 750, log = () => {} }: SuperviseOptions): {
  stop(): Promise<void>;
} {
  let child = start();
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;
  const watchers: FSWatcher[] = [];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    watchers.push(watch(dir, { recursive: true }, () => schedule()));
  }
  const schedule = () => {
    if (stopping) return;
    clearTimeout(timer);
    timer = setTimeout(restart, debounceMs);
  };
  const restart = async () => {
    if (stopping) return;
    log("a package's dist changed; restarting");
    await end(child);
    if (!stopping) child = start();
  };
  return {
    async stop() {
      stopping = true;
      clearTimeout(timer);
      for (const w of watchers) w.close();
      await end(child);
    },
  };
}

/** SIGTERM, up to 5 seconds, then SIGKILL; resolves once the child has exited. */
function end(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * Starts a build watcher per linked package, in its directory: `tsc -p tsconfig.build.json
 * --watch`, and `vite build --watch` for one built with vite; each line they print goes to `log`
 * under the package's name. `stop` ends them all.
 */
export function startWatchers(
  packages: readonly LinkedPackage[],
  log: (line: string) => void,
): { stop(): Promise<void> } {
  const children: ChildProcess[] = [];
  for (const { name, dir, vite } of packages) {
    const commands = [["tsc", "-p", "tsconfig.build.json", "--watch", "--preserveWatchOutput"]];
    if (vite) commands.push(["vite", "build", "--watch"]);
    for (const command of commands) {
      const child = spawn("pnpm", ["exec", ...command], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      const prefix = `[${name}${command[0] === "vite" ? " vite" : ""}]`;
      for (const stream of [child.stdout, child.stderr]) {
        createInterface({ input: stream! }).on("line", (line) => line.trim() && log(`${prefix} ${line}`));
      }
      child.on("error", (err) => log(`${prefix} could not start: ${err.message}`));
      children.push(child);
    }
  }
  return { stop: async () => void (await Promise.all(children.map(end))) };
}
