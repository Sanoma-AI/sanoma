import { spawn, type SpawnOptions } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt as ensure, waitFor } from "@sanoma-ai/testing";

/** The repo's root. */
export const repo = fileURLToPath(new URL("../../../", import.meta.url));

/** This package's `src/cli.ts`, which the tests run with Node as a company repo would run the bin. */
export const cli = join(repo, "packages/sanoma/src/cli.ts");

/**
 * The packages a fixture copy loads through its `node_modules`, each as a published package would
 * be: by its `exports`, from `dist/` (and `sanoma`'s generated `oxlint.json`). `ensureBuilt`
 * builds each whose outputs are missing or older than its source, in dependency order.
 */
const BUILT: [dir: string, outputs: string[]][] = [
  ["packages/workflows", ["dist/index.js"]],
  ["packages/bridge", ["dist/index.js"]],
  ["connectors/ghost", ["dist/index.js"]],
  ["connectors/docker", ["dist/index.js"]],
  ["packages/app", ["dist/server/server.js"]],
  ["packages/sanoma", ["dist/index.js", "dist/oxlint-plugin.js", "oxlint.json"]],
];

export function ensureBuilt(): void {
  for (const [dir, outputs] of BUILT) ensure(join(repo, dir), outputs, ["pnpm", "run", "build"]);
}

const allow = { answer: "allow" };

/**
 * The fixture's Permissions grid, as `sanoma check` reports it: no policies, so everyone may;
 * Ghost's operations write and publish, so none may be called directly: only the runtime's
 * listing of apps, built in.
 */
export const FIXTURE_GRID = {
  groups: [null, "agents"],
  workflows: [
    {
      id: "hello",
      title: "Say hello",
      cells: [allow, allow],
      ops: [
        { id: "ghost.post.create", cells: [allow, allow] },
        { id: "ghost.post.publish", cells: [allow, allow] },
      ],
    },
  ],
  // The runtime's listing of apps, built in: the one operation anyone may call directly.
  ops: [{ id: "sanoma.apps.list", cells: [allow, allow] }],
};

/**
 * A fresh copy of `fixtures/project` (or of the repo at `from`, such as the template), with what a
 * company repo installs: `sanoma` as pnpm lays out its tarball (its published files in
 * `.pnpm/sanoma/node_modules/sanoma`, its dependencies linked beside it, not under it) and
 * `@sanoma-ai/connector-ghost`, both reaching this checkout's builds.
 */
export function copyFixture(from = fileURLToPath(new URL("./fixtures/project/", import.meta.url))): string {
  const dir = mkdtempSync(join(tmpdir(), "sanoma-fixture-"));
  cpSync(from, dir, { recursive: true });
  const modules = join(dir, "node_modules");
  linkConnector(dir, "ghost");

  const sanoma = join(repo, "packages/sanoma");
  const manifest = JSON.parse(readFileSync(join(sanoma, "package.json"), "utf8")) as {
    files: string[];
    dependencies: Record<string, string>;
  };
  const store = join(modules, ".pnpm/sanoma/node_modules");
  for (const file of ["package.json", ...manifest.files]) {
    cpSync(join(sanoma, file), join(store, "sanoma", file), { recursive: true });
  }
  for (const name of Object.keys(manifest.dependencies)) link(join(sanoma, "node_modules", name), join(store, name));
  symlinkSync(join(store, "sanoma"), join(modules, "sanoma"));
  return dir;
}

/** This checkout's `connectors/<name>` installed in the copy at `dir` as `@sanoma-ai/connector-<name>`. */
export const linkConnector = (dir: string, name: string) =>
  link(join(repo, "connectors", name), join(dir, "node_modules", `@sanoma-ai/connector-${name}`));

/** A symlink at `at` to `target`'s real path, its directory made first. */
function link(target: string, at: string): void {
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(realpathSync(target), at);
}

export interface Finished {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Runs the bin with `args` in `cwd` to its end. */
export function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<Finished> {
  const child = startCli(cwd, args, env);
  return child.finished;
}

/**
 * Starts the bin (this checkout's, or `bin`) with `args` in `cwd`; `finished` resolves when it
 * exits, with what it printed. Without NODE_PATH, as a company's install has none: pnpm's vitest
 * shim sets it to the workspace's hoisted packages, where a company's site would find what it
 * must get from the app (Tailwind). Its stdin is a pipe left open, as a parent process's
 * (`SANOMA_EVENTS=1` stops on its end).
 */
export function startCli(cwd: string, args: string[], env: NodeJS.ProcessEnv, bin = cli) {
  const options: SpawnOptions = {
    cwd,
    env: { ...process.env, NODE_PATH: "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  };
  const child = spawn(process.execPath, [bin, ...args], options);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const finished = new Promise<Finished>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, finished, output: () => ({ stdout, stderr }) };
}

/**
 * The bin (this checkout's, or `bin`) with `args` in `cwd` until it listens: where, its output so
 * far, and `stop` (SIGINT), which resolves to what it printed on stderr, or throws on an exit code
 * but 0; the `child` and when it has `finished`, for a stop of another kind.
 */
export async function serving(cwd: string, args: string[], env: NodeJS.ProcessEnv, bin = cli) {
  const { child, finished, output } = startCli(cwd, args, env, bin);
  const listening = / at (http:\/\/127\.0\.0\.1:\d+); ctrl-c to stop/;
  const stop = async () => {
    child.kill("SIGINT");
    const done = await finished;
    if (done.code !== 0) throw new Error(`sanoma exited with ${done.code}: ${done.stderr}`);
    return done.stderr;
  };
  // Until it listens, or exits first (a crash at startup reported at once, not after the wait).
  let exited = false;
  void finished.then(() => (exited = true));
  try {
    const stdout = await waitFor(
      () => output().stdout,
      (out) => exited || listening.test(out),
      60_000,
    );
    const url = stdout.match(listening)?.[1];
    if (url === undefined) throw new Error("sanoma exited before it listened");
    return { url, stop, output, child, finished };
  } catch (err) {
    child.kill("SIGINT");
    await finished;
    throw new Error(output().stderr, { cause: err });
  }
}
