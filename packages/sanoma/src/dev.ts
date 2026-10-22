import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, watch } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join, sep } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

/*
 * Dev mode: when the repo's `sanoma` or a `@sanoma-ai/*` package resolves into a sanoma checkout (a
 * `pnpm link`), or `SANOMA_DEV_REPO` is set, `sanoma` runs the `watch` script of each package it
 * reaches in the checkout and restarts `sanoma serve` when one's `dist/` changes.
 */

/** Whether a path is inside some `node_modules` directory. */
const installed = (path: string) => path.split(sep).includes("node_modules");

export interface LinkedPackage {
  /** The npm name, such as `@sanoma-ai/workflows`. */
  name: string;
  /** Where it really is: its directory in the checkout. */
  dir: string;
}

/**
 * The packages dev mode builds: `node_modules/sanoma` and every package under
 * `node_modules/@sanoma-ai/` whose real path is outside any `node_modules` (the ones a `pnpm link`
 * points into a checkout), then each core package (`corePackages`) that resolves into the checkout
 * through them, such as `sanoma`'s own dependencies when `sanoma` alone is linked.
 */
export function linkedPackages(cwd: string): LinkedPackage[] {
  const modules = join(cwd, "node_modules");
  const scoped = join(modules, "@sanoma-ai");
  const candidates = [
    ...(existsSync(scoped) ? readdirSync(scoped).map((name) => [`@sanoma-ai/${name}`, join(scoped, name)]) : []),
    ["sanoma", join(modules, "sanoma")],
  ] as const;
  const linked: LinkedPackage[] = [];
  for (const [name, path] of candidates) {
    if (!existsSync(path)) continue;
    const dir = realpathSync(path);
    if (!installed(dir)) linked.push({ name, dir });
  }
  for (const core of corePackages(cwd)) {
    if (!installed(core.dir) && !linked.some((p) => p.name === core.name)) linked.push(core);
  }
  return linked;
}

/** The packages a `sanoma` process loads besides the connectors. */
const CORE = ["sanoma", "@sanoma-ai/workflows", "@sanoma-ai/app", "@sanoma-ai/bridge"];

/**
 * Where `sanoma`, `@sanoma-ai/workflows`, `@sanoma-ai/app` and `@sanoma-ai/bridge` really are, those
 * Node finds: each from the repo's root, else from where `sanoma` really is (where pnpm puts
 * sanoma's own dependencies, `@sanoma-ai/app` among them, or the checkout's workspace links).
 */
function corePackages(cwd: string): LinkedPackage[] {
  const sanoma = findPackage("sanoma", cwd);
  const found: LinkedPackage[] = [];
  for (const name of CORE) {
    const dir =
      name === "sanoma"
        ? sanoma
        : (findPackage(name, cwd) ?? (sanoma === undefined ? undefined : findPackage(name, sanoma)));
    if (dir !== undefined) found.push({ name, dir });
  }
  return found;
}

/**
 * Of the core packages (`corePackages`), those installed (from a tarball or a registry) while
 * another of them resolves into a checkout: a partial link, under which two copies of a package
 * run in one process. Empty when none is linked, or all are.
 */
export function partialLink(cwd: string): string[] {
  const core = corePackages(cwd);
  return core.some((p) => !installed(p.dir)) ? core.filter((p) => installed(p.dir)).map((p) => p.name) : [];
}

/** The real directory of package `name` as Node resolves it from the directory `from`, if it does. */
function findPackage(name: string, from: string): string | undefined {
  try {
    const manifest = findPackageJSON(name, pathToFileURL(join(from, "/")));
    return manifest === undefined ? undefined : realpathSync(dirname(manifest));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") return undefined;
    throw err;
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
  /** Directories under them whose changes restart nothing. */
  ignore?: string[];
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
export function supervise({
  spawn: start,
  watch: dirs,
  ignore = [],
  debounceMs = 750,
  log = () => {},
}: SuperviseOptions): {
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
    return watch(dir, { recursive: true }, (_event, name) => {
      const changed = name === null ? dir : join(dir, name);
      if (ignore.some((skip) => changed === skip || changed.startsWith(skip + sep))) return;
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
