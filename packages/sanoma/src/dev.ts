import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, watch } from "node:fs";
import { dirname, join, sep } from "node:path";
import { createInterface } from "node:readline";
import { system32 } from "./windows.ts";

/*
 * Dev mode: when the repo's `sanoma` or a `@sanoma-ai/*` package resolves into a sanoma checkout (a
 * `pnpm link`), or `SANOMA_DEV_REPO` is set, `sanoma` runs the `watch` script of each package it
 * reaches in the checkout and restarts `sanoma serve` when one's build (`buildDirs`) changes.
 */

/** Whether a path is inside some `node_modules` directory. */
const installed = (path: string) => path.split(sep).includes("node_modules");

export interface LinkedPackage {
  /** The npm name, such as `sanoma`. */
  name: string;
  /** Where it really is: its directory in the checkout. */
  dir: string;
}

/**
 * The packages dev mode builds: `node_modules/sanoma` and every package under
 * `node_modules/@sanoma-ai/` whose real path is outside any `node_modules` (the ones a `pnpm link`
 * points into a checkout). Nothing when nothing is linked.
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
  return linked;
}

/** The parts of `sanoma` a running company never loads (the test helpers, `sanoma dev`): not watched. */
const NOT_RUN = new Set(["testing/dist", "dev/dist"]);

/**
 * Where a package's build writes, which dev mode watches: each `dist` its `files` ships (`sanoma`'s
 * own and each of its parts', `workflows/dist`, `app/dist`, …, but `NOT_RUN`), else its `dist/`.
 */
export function buildDirs({ dir }: LinkedPackage): string[] {
  const { files = [] } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { files?: string[] };
  const dirs = files
    .filter((file) => (file === "dist" || file.endsWith("/dist")) && !NOT_RUN.has(file))
    .map((file) => join(dir, file));
  return dirs.length ? dirs : [join(dir, "dist")];
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

/**
 * Calls `onUnlinked` once, when none of `packages` is linked into the repo in `cwd` any more: its
 * `node_modules/<name>` no longer the package's directory on two looks in a row, `intervalMs`
 * apart, so a link an install swaps for a moment is not taken for an unlink. Nothing when none is
 * linked to begin with (`SANOMA_DEV_REPO`). Returns what stops the looks.
 */
export function whenUnlinked(
  cwd: string,
  packages: readonly LinkedPackage[],
  onUnlinked: () => void,
  intervalMs = 1000,
): () => void {
  const linked = () =>
    packages.some(({ name, dir }) => {
      try {
        return realpathSync(join(cwd, "node_modules", name)) === dir;
      } catch {
        return false;
      }
    });
  if (!linked()) return () => {};
  let misses = 0;
  const timer = setInterval(() => {
    misses = linked() ? 0 : misses + 1;
    if (misses < 2) return;
    clearInterval(timer);
    onUnlinked();
  }, intervalMs);
  return () => clearInterval(timer);
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
 * or `sh` it runs started): SIGTERM to the group, SIGKILL after 5 seconds; on Windows, which has
 * neither, `taskkill /T /F`. Resolves once the child has exited, at once when it already has or
 * never started.
 */
export function end(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve();
  const pid = child.pid;
  const signal = (name: NodeJS.Signals) => {
    if (process.platform === "win32") {
      // When it cannot, the child alone, so `end` still resolves.
      execFile(system32("taskkill.exe"), ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
        if (err) child.kill();
      });
      return;
    }
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
 * `stop` ends them all. Through a shell, as pnpm is a `.cmd` shim on Windows, which Node starts only
 * through one.
 */
export function startWatchers(
  packages: readonly LinkedPackage[],
  log: (line: string) => void,
): { stop(): Promise<void> } {
  const children = packages.map(({ name, dir }) => {
    const child = spawn("pnpm run watch", {
      cwd: dir,
      shell: true,
      // On Windows `detached` means a console window of its own.
      detached: process.platform !== "win32",
      windowsHide: true,
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
