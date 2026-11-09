import { spawn, type SpawnOptions } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Relative, not `sanoma/testing`: scripts/readme-shots imports this with Node before anything is built.
import { ensureBuilt as ensure, waitFor } from "../testing/src/build.ts";

/** The repo's root. */
export const repo = fileURLToPath(new URL("../../../", import.meta.url));

/** This package, and its manifest. */
const sanoma = join(repo, "packages/sanoma");
const manifest = JSON.parse(readFileSync(join(sanoma, "package.json"), "utf8")) as {
  exports: Record<string, string | { "sanoma-source"?: string; default: string }>;
  files: string[];
  dependencies: Record<string, string>;
};

/** This package's `src/cli.ts`, which the tests run with Node as a company repo would run the bin. */
export const cli = join(sanoma, "src/cli.ts");

/**
 * `sanoma` built, as a fixture copy loads it through its `node_modules`: each entry of its `exports`
 * from `dist/`, its generated `oxlint.json` and the app's own build. `pnpm run build` when one is
 * missing or the package's source changed since: each part's `src/` and `tsconfig.build.json`, the
 * app's `vite.config.ts`, the runtime's `oxlint.json`, `package.json` and `scripts/`. Every test that
 * loads a build calls this, under its one lock.
 */
export function ensureSanomaBuilt(): void {
  const entries = Object.values(manifest.exports).flatMap((entry) =>
    typeof entry === "object" && entry.default.includes("/dist/") ? [entry.default] : [],
  );
  ensure(
    sanoma,
    [...entries, "oxlint.json", "app/dist/server/server.js"],
    ["pnpm", "run", "build"],
    [
      "package.json",
      "scripts/**",
      "src/**",
      "*/src/**",
      "tsconfig.build.json",
      "*/tsconfig.build.json",
      "app/vite.config.ts",
      "workflows/oxlint.json",
    ],
  );
}

/** `sanoma` and the connectors a fixture copy installs, the template's among them, built (`ensureSanomaBuilt`). */
export function ensureBuilt(): void {
  ensureSanomaBuilt();
  for (const name of ["ghost", "anthropic", "docker", "github", "resend", "sanoma-cloud"]) {
    ensure(join(repo, "connectors", name), ["dist/index.js"], ["pnpm", "run", "build"]);
  }
}

const allow = { answer: "allow" };

/**
 * The fixture's Permissions grid, as `sanoma check` reports it: no policies, so everyone may;
 * Ghost's operations write and publish, so none may be called directly: only the runtime's
 * listing of apps and connection metadata operations, built in.
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
  ops: [
    "sanoma.apps.list",
    "sanoma.connection.activate",
    "sanoma.connection.authorize",
    "sanoma.connection.bind",
    "sanoma.connection.configure",
    "sanoma.connection.create",
    "sanoma.connection.disconnect",
    "sanoma.connection.prepare",
    "sanoma.connection.refresh",
    "sanoma.connection.revoke",
    "sanoma.connection.test",
    "sanoma.run.inspect",
    "sanoma.storeMigration.cancel",
    "sanoma.storeMigration.plan",
  ].map((id) => ({ id, cells: [allow, allow] })),
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

  const store = join(modules, ".pnpm/sanoma/node_modules");
  for (const file of manifest.files.filter((entry) => !entry.startsWith("!"))) {
    cpSync(join(sanoma, file), join(store, "sanoma", file), { recursive: true });
  }
  // Without the condition naming each entry's source: the tests' Vite resolves every import with it, a
  // company's install never does.
  const exports = Object.fromEntries(
    Object.entries(manifest.exports).map(([key, entry]) => {
      if (typeof entry === "string") return [key, entry];
      const { "sanoma-source": _, ...built } = entry;
      return [key, built];
    }),
  );
  writeFileSync(join(store, "sanoma/package.json"), JSON.stringify({ ...manifest, exports }, null, 2));
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
