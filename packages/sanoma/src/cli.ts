#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ResolvedConfig, SanomaConfig } from "@sanoma/workflows";
import { type LoadedConfig, loadConfig, UsageError } from "./config.ts";

// Only Node's modules and ./config.ts are imported here: each command imports what it runs, so
// `--help`, `env`, `ledger export` and the dev-mode parent load neither the worker nor the app.

const USAGE = `usage: sanoma [command]

Runs the repo in the working directory, from its sanoma.config.ts (after its .env, when there is one).

  sanoma                              the worker and the app; starts Postgres in Docker when nothing answers
  sanoma worker                       the worker alone, for a deployment
  sanoma app                          the app alone, for a deployment
  sanoma check                        typecheck, lint, read the config, run every scenario; exit 1 on a problem
  sanoma env [--check]                write .env.example from the drivers' variables; --check exits 1 when it is out of date
  sanoma ledger export <runId> [--out <file>]
                                      a run's ledger records as JSON lines

SANOMA_DATABASE_URL names Postgres (default postgresql://postgres:dbos@localhost:5433/sanoma); SANOMA_APP_PORT the
app's port (default 3000; 0 for any free port). With @sanoma/workflows linked from a sanoma checkout, or
SANOMA_DEV_REPO set, \`sanoma\` also builds the checkout's packages as they change and restarts on a new build.
`;

/** Exit codes: 2 for how the bin was called or what it found, 1 for failed checks and failures while running. */
const USAGE_EXIT = 2;

const log = (line: string) => console.error(line);

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs the command line; returns the exit code, or never, for a command that serves until a signal. */
export async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (err) {
    throw new UsageError(`${messageOf(err)}\n\n${USAGE.trimEnd()}`);
  }
  const { positionals, values } = args;
  if (values.help) {
    console.log(USAGE.trimEnd());
    return 0;
  }
  const [command, ...rest] = positionals;
  switch (command) {
    case undefined: {
      const { devRepo } = await import("./dev.ts");
      const repo = devRepo(process.cwd());
      return repo === undefined ? serveCommand() : dev(repo);
    }
    case "serve":
      return serveCommand();
    case "worker": {
      const { runWorker } = await import("./serve.ts");
      return keep(await load(), runWorker);
    }
    case "app": {
      const { runApp } = await import("./serve.ts");
      return keep(await load(), (config) => runApp(config, { port: port() }));
    }
    case "check":
      return runCheck();
    case "env":
      return env(values.check ?? false);
    case "ledger": {
      const [sub, runId, ...extra] = rest;
      if (sub !== "export" || !runId || extra.length)
        throw new UsageError(`usage: sanoma ledger export <runId> [--out <file>]`);
      return ledgerExport(runId, values.out);
    }
    default:
      throw new UsageError(`unknown command "${command}"\n\n${USAGE.trimEnd()}`);
  }
}

const parse = (argv: string[]) =>
  parseArgs({
    args: argv,
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" }, check: { type: "boolean" }, out: { type: "string" } },
  });

const port = () => Number(process.env.SANOMA_APP_PORT ?? 3000);

/** The config, loaded once, and resolved once: its app name, database URL and workflows. */
interface Loaded extends LoadedConfig {
  resolved: ResolvedConfig;
}

async function load(): Promise<Loaded> {
  const loaded = await loadConfig();
  const { resolveConfig } = await import("@sanoma/workflows");
  return { ...loaded, resolved: resolveConfig(loaded.config) };
}

/**
 * Starts what `start` starts over the loaded config, prints what runs (and where, when it
 * listens), and stops it on SIGINT or SIGTERM, then exits 0.
 */
async function keep(
  { config, resolved }: Loaded,
  start: (config: SanomaConfig) => Promise<{ stop(): Promise<void>; url?: string }>,
): Promise<never> {
  const started = await start(config);
  const running = `${resolved.appName} running ${[...resolved.workflows.keys()].join(", ")}`;
  if (started.url === undefined) {
    console.log(`${running}; ctrl-c to stop`);
  } else {
    console.log(running);
    console.log(`${resolved.appName} at ${started.url}; ctrl-c to stop`);
  }
  onSignal(() => started.stop());
  return new Promise(() => {});
}

/** `sanoma serve` (and `sanoma` outside dev mode): Postgres, then the worker and the app in this process. */
async function serveCommand(): Promise<never> {
  const loaded = await load();
  await postgres(loaded.resolved);
  const { serve } = await import("./serve.ts");
  return keep(loaded, (config) => serve(config, { port: port() }));
}

/** Dev mode: `sanoma serve` in a child it restarts on a new build, and the linked packages' builds. */
async function dev(repo: string): Promise<never> {
  const { linkedPackages, startWatchers, supervise } = await import("./dev.ts");
  const cwd = process.cwd();
  const packages = linkedPackages(cwd);
  log(`dev mode: ${repo}; building ${packages.map((p) => p.name).join(", ") || "nothing"} as it changes`);
  const watchers = startWatchers(packages, log);
  const cli = fileURLToPath(import.meta.url);
  const child = supervise({
    spawn: () => spawn(process.execPath, [cli, "serve"], { cwd, env: process.env, stdio: "inherit" }),
    watch: packages.map((p) => join(p.dir, "dist")),
    log,
  });
  onSignal(async () => {
    await child.stop();
    await watchers.stop();
  });
  return new Promise(() => {});
}

/** Makes sure Postgres answers at the config's URL, starting it in Docker when it may. */
async function postgres({ appName, databaseUrl }: ResolvedConfig): Promise<void> {
  const { ensurePostgres, masked } = await import("./postgres.ts");
  const { how, container } = await ensurePostgres(databaseUrl, { appName, log });
  if (how === "answered") log(`Postgres answers at ${masked(databaseUrl)}`);
  else log(`Postgres ${how === "created" ? "created" : "reused"} in Docker: container ${container}`);
}

async function runCheck(): Promise<number> {
  const loaded = await load();
  await postgres(loaded.resolved);
  const databaseUrl = new URL(loaded.resolved.databaseUrl);
  databaseUrl.pathname = `${databaseUrl.pathname}_check`;
  const { check } = await import("./check.ts");
  const { ok, problems } = await check(loaded, { databaseUrl: databaseUrl.toString(), log });
  for (const problem of problems) console.log(problem);
  log(ok ? "ok" : `${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  return ok ? 0 : 1;
}

async function env(checkOnly: boolean): Promise<number> {
  const { config, root } = await loadConfig();
  const { writeEnvExample } = await import("./env.ts");
  const { changed } = writeEnvExample(root, config, { check: checkOnly });
  if (!checkOnly) {
    log(changed ? "wrote .env.example" : ".env.example is up to date");
    return 0;
  }
  if (changed) log("`.env.example` is out of date: run `sanoma env`");
  return changed ? 1 : 0;
}

async function ledgerExport(runId: string, out: string | undefined): Promise<number> {
  const { config } = await loadConfig();
  const { exportLedger } = await import("./ledger.ts");
  const text = await exportLedger(config, runId);
  if (out === undefined) process.stdout.write(text);
  else {
    writeFileSync(out, text);
    log(`wrote ${out}`);
  }
  return 0;
}

/** On the first SIGINT or SIGTERM, stops what runs and exits 0; a second signal exits at once. */
function onSignal(stop: () => Promise<void>): void {
  let stopping = false;
  const handle = () => {
    if (stopping) process.exit(130);
    stopping = true;
    stop().then(
      () => process.exit(0),
      (err: unknown) => {
        log(messageOf(err));
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", handle);
  process.once("SIGTERM", handle);
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    log(messageOf(err));
    process.exitCode = err instanceof UsageError ? USAGE_EXIT : 1;
  }
}
