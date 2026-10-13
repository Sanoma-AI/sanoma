import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, watch } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { createInterface } from "node:readline";

/*
 * Dev mode: when the repo's `sanoma` or a `@sanoma/*` package resolves into a sanoma checkout (a
 * `pnpm link`), or `SANOMA_DEV_REPO` is set, `sanoma` runs each linked package's `watch` script
 * and restarts `sanoma serve` when one's `dist/` changes.
 */

/** Whether a path is inside some `node_modules` directory. */
const installed = (path: string) => path.split(sep).includes("node_modules");

export interface LinkedPackage {
  /** The npm name, such as `@sanoma/workflows`. */
  name: string;
  /** Where it really is: its directory in the checkout. */
  dir: string;
}

/**
 * `node_modules/sanoma` and every package under `node_modules/@sanoma/` whose real path is
 * outside any `node_modules`: the ones a `pnpm link` points into a checkout.
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
    if (!installed(dir)) linked.push({ name, dir });
  }
  return linked;
}

/** The packages a `sanoma` process loads besides the connectors. */
const CORE = ["sanoma", "@sanoma/workflows", "@sanoma/app", "@sanoma/bridge"];

/**
 * Of `sanoma`, `@sanoma/workflows`, `@sanoma/app` and `@sanoma/bridge`, those installed (from a
 * tarball or a registry) while another of them resolves into a checkout: a partial link, under
 * which two copies of a package run in one process. Empty when none is linked, or all are. Each
 * is found as Node finds it, from the repo's root, else from where `sanoma` really is (where pnpm
 * puts sanoma's own dependencies, `@sanoma/app` among them).
 */
export function partialLink(cwd: string): string[] {
  const sanoma = findPackage("sanoma", cwd);
  const found = CORE.flatMap((name) => {
    const dir = findPackage(name, cwd) ?? (sanoma === undefined ? undefined : findPackage(name, sanoma));
    return dir === undefined ? [] : [{ name, dir }];
  });
  if (!found.some(({ dir }) => !installed(dir))) return [];
  return found.filter(({ dir }) => installed(dir)).map(({ name }) => name);
}

/** The real directory of package `name` as Node resolves it from `from`: `node_modules/<name>` in it or an ancestor. */
function findPackage(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (basename(dir) !== "node_modules" && existsSync(candidate)) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * The sanoma checkout dev mode builds from: `SANOMA_DEV_REPO` when set, else the directory two
 * above a linked package (its `packages/<name>` or `connectors/<name>`). Undefined outside dev
 * mode: nothing linked, and the variable unset.
 */
export function devRepo(cwd: string, linked: readonly LinkedPackage[] = linkedPackages(cwd)): string | undefined {
  if (process.env.SANOMA_DEV_REPO) return process.env.SANOMA_DEV_REPO;
  const [first] = linked;
  return first && dirname(dirname(first.dir));
}

export interface SuperviseOptions {
  /** Starts the child, in a process group of its own (`detached: true`); called again for each restart. */
  spawn: () => ChildProcess;
  /** Directories to watch, recursively; each is created when missing. */
  watch: string[];
  /** How long after the last change to wait before restarting. Default 750 ms. */
  debounceMs?: number;
  log?: (line: string) => void;
}

/**
 * Runs the child and restarts it when anything under a watched directory changes, after
 * `debounceMs` of quiet: its group ended (`end`), then `spawn` again. Restarts run one at a time,
 * in order. A child that exits on its own is reported and started again on the next change.
 * `stop` stops watching, waits for a restart under way, and ends the child.
 */
export function supervise({ spawn: start, watch: dirs, debounceMs = 750, log = () => {} }: SuperviseOptions): {
  stop(): Promise<void>;
} {
  const ending = new WeakSet<ChildProcess>();
  const run = () => {
    const child = start();
    child.once("exit", (code, signal) => {
      if (!ending.has(child)) log(`serve exited with ${signal ?? `code ${code}`}; waiting for a change to restart`);
    });
    return child;
  };
  const stopChild = (child: ChildProcess) => {
    ending.add(child);
    return end(child);
  };

  let child = run();
  let turn = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const watchers = dirs.map((dir) => {
    mkdirSync(dir, { recursive: true });
    return watch(dir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        turn = turn
          .then(async () => {
            log("a package's dist changed; restarting");
            await stopChild(child);
            child = run();
          })
          .catch((err: unknown) => log(`could not restart: ${(err as Error).message}`));
      }, debounceMs);
    });
  });
  return {
    async stop() {
      for (const w of watchers) w.close();
      clearTimeout(timer);
      await turn;
      await stopChild(child);
    },
  };
}

/**
 * Ends a child started with `detached: true` and everything in its process group (what a `pnpm`
 * or `sh` it runs started): SIGTERM to the group, SIGKILL after 5 seconds. Resolves once the
 * child has exited, at once when it already has or never started.
 */
export function end(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve();
  const pid = child.pid;
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name);
    } catch {
      // The group is gone already.
    }
  };
  return new Promise((resolve) => {
    const kill = setTimeout(() => signal("SIGKILL"), 5000);
    const done = () => {
      clearTimeout(kill);
      resolve();
    };
    child.once("exit", done);
    child.once("error", done);
    signal("SIGTERM");
  });
}

/**
 * Runs `pnpm run watch` in each linked package, in a process group of its own, each line it
 * prints going to `log` under the package's name: the package's own script decides how it builds.
 * `stop` ends them all.
 */
export function startWatchers(
  packages: readonly LinkedPackage[],
  log: (line: string) => void,
): { stop(): Promise<void> } {
  const children = packages.map(({ name, dir }) => {
    const child = spawn("pnpm", ["run", "watch"], {
      cwd: dir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on("line", (line) => line.trim() && log(`[${name}] ${line}`));
    }
    child.on("error", (err) => log(`[${name}] could not start: ${err.message}`));
    return child;
  });
  return { stop: async () => void (await Promise.all(children.map(end))) };
}
