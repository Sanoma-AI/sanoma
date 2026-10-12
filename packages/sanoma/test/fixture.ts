import { execFileSync, spawn, type SpawnOptions } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo's root. */
export const repo = fileURLToPath(new URL("../../../", import.meta.url));

/** This package's `src/cli.ts`, which the tests run with Node as a company repo would run the bin. */
export const cli = join(repo, "packages/sanoma/src/cli.ts");

/**
 * The packages a fixture copy loads through its `node_modules`, each as a published package would
 * be: by its `exports`, from `dist/`. `ensureBuilt` builds each whose output is missing or older
 * than a file under its `src/`, in dependency order.
 */
const BUILT: { dir: string; output: string }[] = [
  { dir: "packages/workflows", output: "dist/index.js" },
  { dir: "connectors/ghost", output: "dist/index.js" },
  { dir: "packages/app", output: "dist/server/server.js" },
  { dir: "packages/sanoma", output: "dist/index.js" },
];

export function ensureBuilt(): void {
  for (const { dir, output } of BUILT) {
    const pkg = join(repo, dir);
    const built = join(pkg, output);
    const src = join(pkg, "src");
    const stale =
      !existsSync(built) ||
      readdirSync(src, { recursive: true, encoding: "utf8" }).some(
        (file) => statSync(join(src, file)).mtimeMs > statSync(built).mtimeMs,
      );
    if (stale) execFileSync("pnpm", ["run", "build"], { cwd: pkg, stdio: "inherit" });
  }
}

/**
 * A fresh copy of `fixtures/project` in a temporary directory, with a `node_modules` of symlinks
 * to this checkout's packages (`sanoma`, `@sanoma/workflows`, `@sanoma/connector-ghost`), to
 * `zod`, and to the root's `@types` (for `tsc`): what `npm install` would leave, pointed at the
 * sources' builds. Node resolves each link to its real path, so the config and the bin share one
 * copy of every package.
 */
export function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sanoma-fixture-"));
  cpSync(fileURLToPath(new URL("./fixtures/project/", import.meta.url)), dir, { recursive: true });
  const modules = join(dir, "node_modules");
  mkdirSync(join(modules, "@sanoma"), { recursive: true });
  const link = (name: string, target: string) => symlinkSync(realpathSync(join(repo, target)), join(modules, name));
  link("sanoma", "packages/sanoma");
  link("@sanoma/workflows", "packages/workflows");
  link("@sanoma/connector-ghost", "connectors/ghost");
  link("zod", "packages/workflows/node_modules/zod");
  link("@types", "node_modules/@types");
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

/** Polls `done` every 100 ms until it is true, or throws after `timeoutMs`. */
export async function waitFor(done: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
