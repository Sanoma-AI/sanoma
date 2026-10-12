#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { errorMessage, resolveConfig, resolveDatabaseUrl, type SanomaConfig } from "@sanoma/workflows";
import { check } from "./check.ts";
import { loadConfig, UsageError } from "./config.ts";
import { devRepo, linkedPackages, startWatchers, supervise } from "./dev.ts";
import { writeEnvExample } from "./env.ts";
import { exportLedger } from "./ledger.ts";
import { ensurePostgres } from "./postgres.ts";
import { runApp, runWorker, serve, type Stoppable } from "./serve.ts";

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

/** Runs the command line; returns the exit code, or never, for a command that serves until a signal. */
export async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" }, check: { type: "boolean" }, out: { type: "string" } },
  });
  if (values.help) {
    console.log(USAGE.trimEnd());
    return 0;
  }
  const [command, ...rest] = positionals;
  switch (command) {
    case undefined:
      return runAll();
    case "serve":
      return keep(async (config) => serve(config, { port: port() }), { announce: true });
    case "worker":
      return keep(runWorker);
    case "app":
      return keep(async (config) => runApp(config, { port: port() }), { announce: true });
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
      throw new UsageError(`unknown command "${command}"\n\n${USAGE}`);
  }
}

const port = () => Number(process.env.SANOMA_APP_PORT ?? 3000);

/** Starts what `start` starts over the loaded config, and stops it on SIGINT or SIGTERM, then exits 0. */
async function keep(
  start: (config: SanomaConfig) => Promise<Stoppable & { url?: string }>,
  { announce = false } = {},
): Promise<never> {
  const { config } = await loadConfig();
  const started = await start(config);
  const resolved = resolveConfig(config);
  if (announce) {
    console.log(`${resolved.appName} running ${[...resolved.workflows.keys()].join(", ")}`);
    if (started.url !== undefined) console.log(`${resolved.appName} at ${started.url}; ctrl-c to stop`);
  } else {
    console.log(`${resolved.appName} running ${[...resolved.workflows.keys()].join(", ")}; ctrl-c to stop`);
  }
  onSignal(() => started.stop());
  return new Promise(() => {});
}

/** `sanoma`: Postgres, then the worker and the app, in this process or, in dev mode, in a supervised child. */
async function runAll(): Promise<never> {
  const cwd = process.cwd();
  const { config } = await loadConfig(cwd);
  await postgres(config);
  const repo = devRepo(cwd);
  if (repo === undefined) return keep(async (c) => serve(c, { port: port() }), { announce: true });

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

async function postgres(config: SanomaConfig): Promise<void> {
  const url = resolveDatabaseUrl(config);
  const { how, container } = await ensurePostgres(url, { appName: resolveConfig(config).appName, log });
  if (how === "answered") log(`Postgres answers at ${url.replace(/:[^:@/]*@/, ":***@")}`);
  else log(`Postgres ${how === "created" ? "created" : "reused"} in Docker: container ${container}`);
}

async function runCheck(): Promise<number> {
  const loaded = await loadConfig();
  const url = resolveDatabaseUrl(loaded.config);
  await postgres(loaded.config);
  const databaseUrl = new URL(url);
  databaseUrl.pathname = `${databaseUrl.pathname}_check`;
  const { ok, problems } = await check(loaded, { databaseUrl: databaseUrl.toString(), log });
  for (const problem of problems) console.log(problem);
  log(ok ? "ok" : `${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  return ok ? 0 : 1;
}

async function env(checkOnly: boolean): Promise<number> {
  const { config, root } = await loadConfig();
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
        log(errorMessage(err));
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
    log(errorMessage(err));
    process.exitCode = err instanceof UsageError ? USAGE_EXIT : 1;
  }
}
