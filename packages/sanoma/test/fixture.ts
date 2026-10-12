import { spawn, type SpawnOptions } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt as ensure } from "@sanoma/testing";

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
  ["connectors/ghost", ["dist/index.js"]],
  ["packages/app", ["dist/server/server.js"]],
  ["packages/sanoma", ["dist/index.js", "dist/oxlint-plugin.js", "oxlint.json"]],
];

export function ensureBuilt(): void {
  for (const [dir, outputs] of BUILT) ensure(join(repo, dir), outputs, ["pnpm", "run", "build"]);
}

/**
 * A fresh copy of `fixtures/project` in a temporary directory, with a `node_modules` of two
 * symlinks into this checkout, `sanoma` and `@sanoma/connector-ghost`: what a company repo
 * installs. Everything else (zod, `@types/node`, `@sanoma/workflows`, typescript, oxlint) the
 * copy reaches through those packages' own `node_modules`, as under pnpm's strict layout. Node
 * resolves each link to its real path, so the config and the bin share one copy of every package.
 */
export function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sanoma-fixture-"));
  cpSync(fileURLToPath(new URL("./fixtures/project/", import.meta.url)), dir, { recursive: true });
  const modules = join(dir, "node_modules");
  mkdirSync(join(modules, "@sanoma"), { recursive: true });
  const link = (name: string, target: string) => symlinkSync(realpathSync(join(repo, target)), join(modules, name));
  link("sanoma", "packages/sanoma");
  link("@sanoma/connector-ghost", "connectors/ghost");
  return dir;
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

/** Starts the bin with `args` in `cwd`; `finished` resolves when it exits, with what it printed. */
export function startCli(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  const options: SpawnOptions = { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] };
  const child = spawn(process.execPath, [cli, ...args], options);
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
