#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import type { SanomaConfig } from "@sanoma-ai/workflows";
import { type Loaded, type LoadedConfig, loadConfig, UsageError } from "./config.ts";
import type { LinkedPackage } from "./dev.ts";
import { emit, eventsOn } from "./events.ts";
import type { EnsuredPostgres } from "./postgres.ts";

// Only Node's modules, ./config.ts and ./events.ts are imported here: each command imports what it runs, so
// `--help`, `env`, `ledger export` and the dev-mode parent load neither the worker nor the app (the
// parent loads the app's Node-only build module to see whether there are sites).

const USAGE = `usage: sanoma [command]

Runs the repo in the working directory, from its sanoma.config.ts (after its .env, when there is one).

  sanoma                              the worker and the app, on the company's own Postgres unless a URL is named,
                                      and the repo's sites/, when it has any, from a dev server that shows each
                                      edit as it is saved. In an empty directory, first starts a company there: the
                                      template, .env, an install and a git repository
  sanoma worker                       the worker alone, for a deployment
  sanoma app                          the app alone (built with the sites), for a deployment
  sanoma check                        typecheck, lint, read the config, build and typecheck the sites, run every
                                      scenario on a database of its own; exit 1 on a problem
  sanoma env [--check]                write .env.example from the drivers' variables; --check exits 1 when it is out of date
  sanoma ledger export <runId> [--out <file>]
                                      a run's ledger records as JSON lines

SANOMA_DATABASE_URL names Postgres, used as it is. Without it, sanoma, check and ledger export start the company's
own PostgreSQL 18 in .sanoma/postgres (its records: deleting it deletes them), or use the one another sanoma runs
there; worker and app only use one that runs. SANOMA_APP_PORT the app's port (default 3000; 0 for any free port);
SANOMA_APP_HOST its address (default 127.0.0.1; any other needs GitHub sign-in, see .env.example). With sanoma or a @sanoma-ai package linked from a sanoma checkout,
or SANOMA_DEV_REPO set, \`sanoma\` also runs the watch build of each package it reaches in the checkout and
restarts on a new build.

For a parent process: SANOMA_EVENTS=1 adds a JSON line on stdout per event, {"sanoma":1,"event":…}: "ready" with the
app's "url" (where it listens, on the port SANOMA_APP_PORT names) and its "sites" each time it listens, "error" with the
"message" when it cannot start or stop, and "database" with "how" ("answered", "started" or "created"), "url" and
"place" once the company's own Postgres answers; the end of stdin then stops it as SIGTERM does. sanoma never
prompts, reads stdin only then, and opens no browser; SIGTERM stops everything it started, the app, the worker, then
the Postgres it started unless another client is connected; exit 2 is a mistake in the call or the config, 1 a failure.
`;

/** Exit codes: 2 for how the bin was called or what it found, 1 for failed checks and failures while running. */
const USAGE_EXIT = 2;

const log = (line: string) => console.error(line);

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A failure to start or stop: its message on stderr, and as an `error` event. */
function fail(err: unknown): void {
  const message = messageOf(err);
  log(message);
  emit({ event: "error", message });
}

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
      if (!existsSync(join(process.cwd(), "sanoma.config.ts"))) {
        const { startCompany } = await import("./init.ts");
        if (await startCompany(process.cwd(), { log })) return serveStarted(process.cwd());
      }
      const { devRepo, linkedPackages } = await import("./dev.ts");
      const linked = linkedPackages(process.cwd());
      const repo = devRepo(process.cwd(), linked);
      return repo === undefined ? serveCommand(true) : dev(repo, linked);
    }
    case "serve":
      // --dev (hidden): the child dev mode supervises, serving the sites as `sanoma` does.
      return serveCommand(values.dev ?? false);
    case "worker": {
      const { runWorker } = await import("./serve.ts");
      return keep(await load({ postgres: "find" }), runWorker);
    }
    case "app": {
      const { runApp } = await import("./serve.ts");
      return keep(await load({ postgres: "find" }), (config, resolved) =>
        runApp(config, { port: port(), log, resolved }),
      );
    }
    case "check":
      return runCheck();
    case "api":
      // Hidden: the dev server runs it when the config's files change.
      return writeApiCommand();
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
    options: {
      help: { type: "boolean", short: "h" },
      check: { type: "boolean" },
      out: { type: "string" },
      dev: { type: "boolean" },
    },
  });

const port = () => Number(process.env.SANOMA_APP_PORT ?? 3000);

/**
 * The config, loaded and resolved, with its policy from `policies/**\/*.cedar` (`policyAt`): a
 * problem with them is a `UsageError`, so nothing starts on policies that do not hold. Without
 * `policies`, they are left to the caller (`check` reports them). With `postgres`, its database
 * answers first (`withPostgres`: "start" starts the company's own, "find" only finds it running),
 * so the config resolves on it.
 */
async function load({ policies = true, postgres }: { policies?: boolean; postgres?: "start" | "find" } = {}): Promise<
  Loaded & { postgres?: EnsuredPostgres }
> {
  const loaded = await loadConfig();
  const ensured = postgres && (await withPostgres(namedDatabaseUrl(loaded.config), loaded.root, postgres === "start"));
  const { resolveConfig } = await import("@sanoma-ai/workflows");
  try {
    const resolved = resolveConfig(loaded.config);
    if (policies && resolved.policyProblems.length) {
      throw new UsageError(`The policies do not hold:\n${resolved.policyProblems.join("\n")}`);
    }
    return { ...loaded, resolved, postgres: ensured };
  } catch (err) {
    await ensured?.stop().catch(() => {});
    throw err;
  }
}

/** The database URL the config or the environment names, an empty value as none: else the company's own. */
const namedDatabaseUrl = (config: LoadedConfig["config"]) =>
  config.databaseUrl ?? (process.env.SANOMA_DATABASE_URL || undefined);

/**
 * Makes the database `named` answer, or with none the company's own in `root` (`ensurePostgres`),
 * and names it in this process's `SANOMA_DATABASE_URL`, which the runtime reads and every child
 * inherits; never in `.env`. The company's own is a `database` event, unless `announce` is false.
 */
async function withPostgres(
  named: string | undefined,
  root: string,
  start: boolean,
  { announce = true } = {},
): Promise<EnsuredPostgres> {
  const { ensurePostgres } = await import("./postgres.ts");
  const postgres = await ensurePostgres(named, { root, log, start });
  process.env.SANOMA_DATABASE_URL = postgres.databaseUrl;
  if (named === undefined && announce) {
    emit({ event: "database", how: postgres.how, url: postgres.databaseUrl, place: "this-computer" });
  }
  return postgres;
}

/**
 * Starts what `start` starts over the loaded config, prints what runs (and where, when it
 * listens), and stops it on SIGINT or SIGTERM, then the Postgres `load` started, then exits 0. The worker names the vendors not
 * configured yet itself, in one line.
 */
async function keep(
  { config, resolved, postgres }: Loaded & { postgres?: EnsuredPostgres },
  start: (
    config: SanomaConfig,
    resolved: Loaded["resolved"],
  ) => Promise<{ stop(): Promise<void>; url?: string; sites?: Record<string, string> }>,
): Promise<never> {
  let started: Awaited<ReturnType<typeof start>>;
  try {
    started = await start(config, resolved);
  } catch (err) {
    await postgres?.stop().catch(() => {});
    throw err;
  }
  const running = `${resolved.appName} running ${[...resolved.workflows.keys()].join(", ")}`;
  if (started.url === undefined) {
    console.log(`${running}; ctrl-c to stop`);
  } else {
    console.log(running);
    // Each public site at its own host, before the line that says how to stop.
    for (const [name, url] of Object.entries(started.sites ?? {})) console.log(`${name}: ${url}`);
    console.log(`${resolved.appName} at ${started.url}; ctrl-c to stop`);
    emit({ event: "ready", url: started.url, sites: started.sites ?? {} });
  }
  // Postgres last, once the worker and the app have closed their connections.
  onSignal(() => started.stop().finally(() => postgres?.stop()));
  return new Promise(() => {});
}

/**
 * `sanoma serve` (and `sanoma` outside dev mode): Postgres (the company's own unless one is
 * named), then the worker and the app in this process. With `devServer` (`sanoma`), a repo's sites are served from Vite's dev server, not built.
 */
async function serveCommand(devServer: boolean): Promise<never> {
  const loaded = await load({ postgres: "start" });
  return keep(loaded, async (config, resolved) => {
    (await import("./key.ts")).ensureSecretsKey(process.cwd(), log);
    const { serve } = await import("./serve.ts");
    return serve(config, { port: port(), log, dev: devServer, resolved });
  });
}

/**
 * A company just started in `cwd`: the `sanoma` it installed serves it, in this process, so that
 * the config and the worker load the same packages; this one when it installed none there.
 */
async function serveStarted(cwd: string): Promise<number> {
  const installed = join(cwd, "node_modules/sanoma/dist/cli.js");
  if (!existsSync(installed)) return serveCommand(true);
  const { main: run } = (await import(pathToFileURL(installed).href)) as { main: typeof main };
  return run([]);
}

/**
 * Dev mode: `sanoma serve --dev` in a child it restarts on a new build, and the `watch` of each
 * package reached in the checkout (`linkedPackages`). With sites, the child serves the app's
 * source from Vite's dev server, which updates it in place: a new build of the app's pages (its
 * `dist/client` and `dist/server`) restarts nothing.
 * Each runs in a process group of its own, so a terminal's ctrl-c reaches this process alone, and
 * its `stop` is the one path that ends them. The company's own Postgres, when neither the
 * environment nor `.env` names a URL, is this process's (`withPostgres`, the config unread: one
 * the config names is the child's), so a restart keeps it; the child inherits its URL.
 */
async function dev(repo: string, packages: readonly LinkedPackage[]): Promise<never> {
  const { partialLink, startWatchers, supervise, whenUnlinked } = await import("./dev.ts");
  const cwd = process.cwd();
  log(`dev mode: ${repo}; building ${packages.map((p) => p.name).join(", ") || "nothing"} as it changes`);
  const dotenv = join(cwd, ".env");
  const named =
    process.env.SANOMA_DATABASE_URL ||
    (existsSync(dotenv) && parseEnv(readFileSync(dotenv, "utf8")).SANOMA_DATABASE_URL);
  const postgres = named ? undefined : await withPostgres(undefined, cwd, true);
  const fromTarballs = partialLink(cwd);
  if (fromTarballs.length) {
    log(
      `dev mode: ${fromTarballs.join(", ")} still come from their tarballs, ` +
        "so edits to them in the checkout will not show",
    );
  }
  const watchers = startWatchers(packages, log);
  const cli = fileURLToPath(import.meta.url);
  const app = packages.find((p) => p.name === "@sanoma-ai/app");
  const { siteBuild } = await import("./sites.ts");
  // A linked app with no build yet is not hot: every change restarts the child until it builds.
  const hot = app && (await siteBuild(cwd).catch(() => undefined))?.sitesOf(cwd).sites.length;
  const child = supervise({
    spawn: () =>
      // With SANOMA_EVENTS=1, a stdin of its own that nothing writes: the end of this process's
      // stdin stops this process, which ends the child; the child's ends when this process does.
      spawn(process.execPath, [cli, "serve", "--dev"], {
        cwd,
        env: process.env,
        stdio: [eventsOn() ? "pipe" : "inherit", "inherit", "inherit"],
        detached: true,
      }),
    watch: packages.map((p) => join(p.dir, "dist")),
    ignore: hot ? [join(app.dir, "dist", "client"), join(app.dir, "dist", "server")] : [],
    log,
  });
  const shutdown = onSignal(async () => {
    unwatch();
    try {
      await child.stop();
      await watchers.stop();
    } finally {
      await postgres?.stop();
    }
  });
  // Once the repo is unlinked (`sanoma-dev unlink`, an install), the checkout's server must not
  // keep running in it, nor start again on the checkout's next build: it would write its own
  // route tree and tsconfig into `.sanoma/app` beside the installed sanoma's.
  const unwatch = whenUnlinked(cwd, packages, () => {
    log(`dev mode: the repo no longer links ${repo}; stopping`);
    shutdown();
  });
  return new Promise(() => {});
}

/** `sanoma api` (hidden): writes the generated files from the config, as `check` and `serve` do. */
async function writeApiCommand(): Promise<number> {
  const { config, root, resolved } = await load({ policies: false });
  const { describeConfig, readPeople, schemaOf, writeGenerated } = await import("@sanoma-ai/workflows/describe");
  const { wrote } = await writeGenerated(root, describeConfig(config), schemaOf(resolved, readPeople(root).people));
  for (const file of wrote) log(`wrote ${file}`);
  return 0;
}

/** `sanoma check`: Postgres made to answer, then the checks, the scenarios on `<database>_check`; Postgres stopped after when it started it. */
async function runCheck(): Promise<number> {
  const loaded = await load({ policies: false, postgres: "start" });
  try {
    const { check } = await import("./check.ts");
    const own = new URL(loaded.resolved.databaseUrl);
    own.pathname = `${own.pathname}_check`;
    const result = await check(loaded, { databaseUrl: own.toString(), log });
    const { ok, problems, warnings } = result;
    for (const line of [...warnings, ...problems]) console.log(line);
    emit({ event: "checked", ...result });
    log(ok ? "ok" : `${problems.length} problem${problems.length === 1 ? "" : "s"}`);
    return ok ? 0 : 1;
  } finally {
    await loaded.postgres?.stop();
  }
}

async function env(checkOnly: boolean): Promise<number> {
  const loaded = await load({ policies: false });
  const { writeEnvExample } = await import("./env.ts");
  const { changed } = writeEnvExample(loaded, { check: checkOnly });
  if (!checkOnly) {
    log(changed ? "wrote .env.example" : ".env.example is up to date");
    return 0;
  }
  if (changed) log("`.env.example` is out of date: run `sanoma env`");
  return changed ? 1 : 0;
}

async function ledgerExport(runId: string, out: string | undefined): Promise<number> {
  const loaded = await loadConfig();
  // Its stdout is the records alone: no event.
  const postgres = await withPostgres(namedDatabaseUrl(loaded.config), loaded.root, true, { announce: false });
  try {
    const { exportLedger } = await import("./ledger.ts");
    const text = await exportLedger(loaded.config, runId);
    if (out === undefined) process.stdout.write(text);
    else {
      writeFileSync(out, text);
      log(`wrote ${out}`);
    }
    return 0;
  } finally {
    await postgres.stop();
  }
}

/**
 * On the first SIGINT or SIGTERM, or with `SANOMA_EVENTS=1` the end of stdin (a parent process
 * gone, or done), stops what runs and exits 0; a second signal exits at once. Without the variable
 * stdin is never read. Returns what stops, once, for a caller with a reason of its own to stop.
 */
function onSignal(stop: () => Promise<void>): () => void {
  let stopping = false;
  const stopOnce = () => {
    if (stopping) return;
    stopping = true;
    stop().then(
      () => process.exit(0),
      (err: unknown) => {
        fail(err);
        // Once stdout has taken the line: a pipe's writes are asynchronous on macOS.
        process.stdout.write("", () => process.exit(1));
      },
    );
  };
  const handle = () => (stopping ? process.exit(130) : stopOnce());
  process.once("SIGINT", handle);
  process.once("SIGTERM", handle);
  if (eventsOn()) process.stdin.once("end", stopOnce).once("error", stopOnce).resume();
  return stopOnce;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    fail(err);
    process.exitCode = err instanceof UsageError ? USAGE_EXIT : 1;
  }
}
