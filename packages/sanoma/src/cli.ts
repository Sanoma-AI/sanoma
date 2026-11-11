#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import type { SanomaConfig } from "sanoma/workflows";
import { errorMessage, UsageError } from "sanoma/workflows/shared";
import { type Loaded, type LoadedConfig, loadConfig } from "./config.ts";
import type { LinkedPackage } from "./dev.ts";
import { emit, eventsOn, stage } from "./events.ts";
import type { EnsuredPostgres } from "./postgres.ts";
import type { Listening } from "./listen.ts";

// Only Node's modules, sanoma/workflows/shared, ./config.ts and ./events.ts are imported here: each
// command imports what it runs, so `--help`, `env`, `ledger export`, `describe`, `call` and the
// dev-mode parent load neither the worker nor the app (the parent loads the app's Node-only build
// module to see whether there are sites).

const INIT_USAGE = "sanoma init [--name <name>] [--you <name>] [--email <email>]";
const CALL_OPTIONS = "[--as <person>] [--url <url>] [--agent <agent>]";
const DESCRIBE_USAGE = `sanoma describe ${CALL_OPTIONS}`;
const CALL_USAGE = `sanoma call <name> [--input <json>] ${CALL_OPTIONS}`;

const USAGE = `usage: sanoma [command]

Runs the repo in the working directory, from its sanoma.config.ts (after its .env, when there is one).

  sanoma                              the worker and the app, on the company's own Postgres unless a URL is named,
                                      and the repo's sites/, when it has any, from a dev server that shows each
                                      edit as it is saved. In an empty directory, first starts a company there: the
                                      template, .env, an install and a git repository
  ${INIT_USAGE}
                                      starts a company in this empty directory, then runs it as sanoma does: --name
                                      the company's name (else the directory's), --you and --email who starts it
                                      (else git's user.name and user.email)
  sanoma worker                       the worker alone, for a deployment; with PORT set, its port answers there:
                                      /healthz, /wake and the app bundle a host's Worker script runs
  sanoma app                          the app alone (built with the sites), for a deployment
  sanoma identity                     standalone runtime/provisioning identity broker from protected host configuration
  sanoma wakeup                       the wakeup service alone, on the config's database: it calls each instance
                                      registered with it at the time the instance asked (port 3100 by default)
  sanoma wakeup account <label>       mints an account of that service, printing {"id","token"} on stdout
  sanoma check                        typecheck, lint, read the config, build and typecheck the sites, run every
                                      scenario on a database of its own; exit 1 on a problem
  sanoma demo --out <dir>             the sites as static files that run their workflows in the page, on the
                                      connectors' fakes from scenarios/world.feature: mount.js, demo.css and
                                      index.html, emptying <dir> first (a site's public/demos/<name>/, say)
  sanoma env [--check]                write .env.example from the drivers' variables; --check exits 1 when it is out of date
  sanoma ledger export <runId> [--out <file>]
                                      a run's ledger records as JSON lines
  ${DESCRIBE_USAGE}
                                      what the running app offers an agent: the company's workflows, direct
                                      operations and collections, as JSON on stdout
  ${CALL_USAGE}
                                      calls the running app: a workflow by its api name (or <api>.start) starts it,
                                      printing {"runId"}; <api>.result waits for the run's end (up to 10 minutes);
                                      <api>.runs and the other reads; an operation by its id. The answer as JSON
                                      on stdout. The app: --url, else the one .sanoma/app.json names while it
                                      runs, else SANOMA_APP_HOST and SANOMA_APP_PORT. Who asks: --as (an id or an
                                      email), else the one person declared, else git's user.email; --agent a
                                      declared agent acting for them. On this machine's app only
  sanoma dev <link|unlink|update>     from a contributor's own Sanoma repo: link it to a sanoma checkout, unlink it,
                                      or update it to the latest release (sanoma dev --help)
  sanoma tfschema <resources.config.ts> <resources.gen.ts> [--fixtures <dir>]
                                      a connector's resource types, from an OpenTofu provider's recorded schema

SANOMA_DATABASE_URL names Postgres, used as it is. Without it, sanoma, check and ledger export start the company's
own PostgreSQL 18 in .sanoma/postgres (its records: deleting it deletes them), or use the one another sanoma runs
there; worker and app only use one that runs. SANOMA_APP_PORT the app's port (default 3000; 0 for any free port);
SANOMA_APP_HOST its address (default 127.0.0.1; any other needs GitHub sign-in, see .env.example). With sanoma or a @sanoma-ai package linked from a sanoma checkout,
or SANOMA_DEV_REPO set, \`sanoma\` also runs the watch build of each package it reaches in the checkout and
restarts on a new build.

For a parent process: SANOMA_EVENTS=1 adds a JSON line on stdout per event, {"sanoma":1,"event":…}: "ready" with the
app's "url" (where it listens, on the port SANOMA_APP_PORT names) and its "sites" each time it listens, "error" with the
"message" when it cannot start or stop, "database" with "how" ("answered", "started" or "created"), "url" and
"place" once the company's own Postgres answers, and "stage" with "stage" and "status" ("start" or "done") for each
stage of starting a company: "template", "people", "git", "install", then "database" (around the company's own
Postgres, on every run); the end of stdin then stops it as SIGTERM does. While the app listens, .sanoma/app.json
holds its {"url","pid"}. sanoma never prompts, reads stdin only then, and opens no browser; SIGTERM stops
everything it started, the app, the worker, then the Postgres it started unless another client is connected; exit 2
is a mistake in the call or the config, 1 a failure.
`;

/** Exit codes: 2 for how the bin was called or what it found, 1 for failed checks and failures while running. */
const USAGE_EXIT = 2;

const log = (line: string) => console.error(line);

/** A failure to start or stop: its message on stderr, and as an `error` event. */
function fail(err: unknown): void {
  const message = errorMessage(err);
  log(message);
  emit({ event: "error", message });
}

/** Runs the command line; returns the exit code, or never, for a command that serves until a signal. */
export async function main(argv: string[]): Promise<number> {
  // Commands that read their own arguments.
  if (argv[0] === "dev") return (await import("sanoma/internal/dev")).dev(argv.slice(1));
  if (argv[0] === "tfschema") return (await import("sanoma/internal/bridge/tfschema/cli")).tfschema(argv.slice(1));
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (err) {
    throw new UsageError(`${errorMessage(err)}\n\n${USAGE.trimEnd()}`);
  }
  const { positionals, values } = args;
  if (values.help) {
    console.log(USAGE.trimEnd());
    return 0;
  }
  const [command, ...rest] = positionals;
  if (command !== "init" && (values.name ?? values.you ?? values.email) !== undefined) {
    throw new UsageError(`--name, --you and --email are sanoma init's: ${INIT_USAGE}`);
  }
  const calling = { input: values.input, as: values.as, url: values.url, agent: values.agent };
  if (command !== "describe" && command !== "call" && Object.values(calling).some((value) => value !== undefined)) {
    throw new UsageError(
      `--input, --as, --url and --agent are sanoma describe's and sanoma call's: ${DESCRIBE_USAGE}, ${CALL_USAGE}`,
    );
  }
  switch (command) {
    case undefined: {
      if (!existsSync(join(process.cwd(), "sanoma.config.ts")) && (await initCompany())) {
        return serveStarted(process.cwd());
      }
      const { devRepo, linkedPackages } = await import("./dev.ts");
      const linked = linkedPackages(process.cwd());
      const repo = devRepo(process.cwd(), linked);
      return repo === undefined ? serveCommand(true) : dev(repo, linked);
    }
    case "init":
      if (rest.length) throw new UsageError(`usage: ${INIT_USAGE}`);
      if (!(await initCompany(values))) {
        throw new UsageError(
          `sanoma init starts a company in an empty directory: ${process.cwd()} holds files already`,
        );
      }
      return serveStarted(process.cwd());
    case "serve":
      // --dev (hidden): the child dev mode supervises, serving the sites as `sanoma` does.
      return serveCommand(values.dev ?? false);
    case "worker": {
      const { runWorker } = await import("./worker-port.ts");
      return keep(await load({ postgres: "find" }), (config) => runWorker(config, log));
    }
    case "app": {
      const { runApp } = await import("./serve.ts");
      return keep(await load({ postgres: "find" }), (config, resolved) =>
        runApp(config, { port: port(), log, resolved }),
      );
    }
    case "identity": {
      if (rest.length) throw new UsageError("usage: sanoma identity");
      const { runIdentity } = await import("./identity.ts");
      const service = await runIdentity();
      console.log(`the identity service at ${service.url}; ctrl-c to stop`);
      emit({ event: "ready", url: service.url, sites: {} });
      onSignal(() => service.stop());
      return new Promise<never>(() => {});
    }
    case "wakeup": {
      const [sub, label, ...extra] = rest;
      if (sub === undefined) return wakeupCommand();
      if (sub !== "account" || !label?.trim() || extra.length)
        throw new UsageError("usage: sanoma wakeup [account <label>]");
      return wakeupAccount(label);
    }
    case "check":
      return runCheck();
    case "api":
      // Hidden: the dev server runs it when the config's files change.
      return writeApiCommand();
    case "app-bundle": {
      // Hidden: the worker's port runs it in a revision's checkout (`appBundleRoute`).
      if (!values.out || rest.length) throw new UsageError("usage: sanoma app-bundle --out <file>");
      const { config, root } = await loadConfig();
      const [{ buildAppBundle }, { parseDomains }] = await Promise.all([
        import("sanoma/app/bundle"),
        import("./serve.ts"),
      ]);
      const domains = parseDomains(process.env.SANOMA_DOMAINS) ?? {};
      const bundle = await buildAppBundle(root, { config, domains, log });
      writeFileSync(values.out, JSON.stringify(bundle));
      return 0;
    }
    case "demo": {
      if (!values.out || rest.length) throw new UsageError("usage: sanoma demo --out <dir>");
      const { config, root } = await loadConfig();
      const { buildDemo } = await import("sanoma/app/demo");
      const { files } = await buildDemo(root, { config, out: values.out, log });
      log(`sanoma: the demo is in ${values.out}: ${files.length} files, mount.js its entry`);
      return 0;
    }
    case "env":
      return env(values.check ?? false);
    case "describe": {
      if (rest.length) throw new UsageError(`usage: ${DESCRIBE_USAGE}`);
      const { describeCommand } = await import("./call.ts");
      return describeCommand(calling);
    }
    case "call": {
      const [name, ...extra] = rest;
      if (!name?.trim() || extra.length) throw new UsageError(`usage: ${CALL_USAGE}`);
      const { callCommand } = await import("./call.ts");
      return callCommand(name, calling);
    }
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
      name: { type: "string" },
      you: { type: "string" },
      email: { type: "string" },
      input: { type: "string" },
      as: { type: "string" },
      url: { type: "string" },
      agent: { type: "string" },
    },
  });

/**
 * Starts a company in the working directory (`startCompany`) when it is empty, named and declared
 * as `sanoma init`'s flags say: whether it did. A flag left empty is one not given; an `--email`
 * that is no address is refused before anything is written.
 */
async function initCompany(values: ReturnType<typeof parse>["values"] = {}): Promise<boolean> {
  const [name, you, email] = [values.name, values.you, values.email].map((value) => value?.trim() || undefined);
  const { isEmail, startCompany, whoIsStarting } = await import("./init.ts");
  if (email && !isEmail(email)) throw new UsageError(`--email: "${email}" is not an email address`);
  return startCompany(process.cwd(), { name, creator: () => whoIsStarting({ name: you, email }), log });
}

/** `SANOMA_APP_PORT`, or `fallback` when it is unset. */
const port = (fallback = 3000) => Number(process.env.SANOMA_APP_PORT ?? fallback);

/**
 * The config, loaded and resolved, with its policy from `policies/**\/*.cedar` (`policyAt`): a
 * problem with them is a `UsageError`, so nothing starts on policies that do not hold. Without
 * `policies`, they are left to the caller (`check` reports them). With `postgres`, its database
 * answers first (`withPostgres`: "start" starts the company's own, "find" only finds it running),
 * so the config resolves on it.
 */
async function load({
  policies = true,
  postgres,
}: { policies?: boolean; postgres?: "serve" | "start" | "find" } = {}): Promise<
  Loaded & { postgres?: EnsuredPostgres }
> {
  const loaded = await loadConfig();
  const ensured =
    postgres &&
    (await withPostgres(namedDatabaseUrl(loaded.config), loaded.root, postgres !== "find", {
      adopt: postgres === "serve",
    }));
  const { resolveConfig } = await import("sanoma/workflows");
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
 * inherits; never in `.env`. The company's own is a `database` event, inside the `database` stage
 * (the last of starting a company, and on every run), unless `announce` is false.
 */
async function withPostgres(
  named: string | undefined,
  root: string,
  start: boolean,
  { announce = true, adopt = false } = {},
): Promise<EnsuredPostgres> {
  const { ensurePostgres } = await import("./postgres.ts");
  const ensure = () => ensurePostgres(named, { root, log, start, adopt });
  const postgres =
    named === undefined && announce
      ? await stage("database", async () => {
          const own = await ensure();
          emit({ event: "database", how: own.how, url: own.databaseUrl, place: "this-computer" });
          return own;
        })
      : await ensure();
  process.env.SANOMA_DATABASE_URL = postgres.databaseUrl;
  return postgres;
}

/**
 * Starts what `start` starts over the loaded config, prints what runs (and where, when it
 * listens, recording that in `.sanoma/app.json` for `sanoma call`, `recordApp`, until it stops), and
 * stops it on SIGINT or SIGTERM, or once what it started has `exited` (done), then the Postgres
 * `load` started, then exits 0. The worker names the vendors not configured yet itself, in one line.
 */
async function keep(
  { config, resolved, postgres }: Loaded & { postgres?: EnsuredPostgres },
  start: (
    config: SanomaConfig,
    resolved: Loaded["resolved"],
  ) => Promise<{ stop(): Promise<void>; exited?: Promise<void>; url?: string; sites?: Record<string, string> }>,
): Promise<never> {
  let started: Awaited<ReturnType<typeof start>>;
  try {
    started = await start(config, resolved);
  } catch (err) {
    await postgres?.stop().catch(() => {});
    throw err;
  }
  // What removes `.sanoma/app.json` again: nothing, until the app listens.
  let forget = nothing;
  const running = `${resolved.name} running ${[...resolved.workflows.keys()].join(", ")}`;
  if (started.url === undefined) {
    console.log(`${running}; ctrl-c to stop`);
  } else {
    console.log(running);
    // Each public site at its own host, before the line that says how to stop.
    for (const [name, url] of Object.entries(started.sites ?? {})) console.log(`${name}: ${url}`);
    // Where `sanoma call` finds it, until it stops: written before it says it is ready.
    const { recordApp } = await import("./app-file.ts");
    forget = recordApp(process.cwd(), started.url, log);
    console.log(`${resolved.name} at ${started.url}; ctrl-c to stop`);
    emit({ event: "ready", url: started.url, sites: started.sites ?? {} });
  }
  // Postgres last, once the worker and the app have closed their connections.
  const stopOnce = onSignal(() => {
    forget();
    return started.stop().finally(() => postgres?.stop());
  });
  // Done on its own (`runWorker`): stopped as a signal stops it, exiting 1 when it failed.
  void started.exited?.then(
    () => stopOnce(),
    (error: unknown) => stopOnce({ error }),
  );
  return new Promise(() => {});
}

const nothing = () => {};

/**
 * `sanoma serve` (and `sanoma` outside dev mode): Postgres (the company's own unless one is
 * named), then the worker and the app in this process. With `devServer` (`sanoma`), a repo's sites are served from Vite's dev server, not built.
 */
async function serveCommand(devServer: boolean): Promise<never> {
  const loaded = await load({ postgres: "serve" });
  return keep(loaded, async (config, resolved) => {
    await (
      await import("./key.ts")
    ).ensureDeploymentKeys(process.cwd(), log, {
      externalStore: config.secrets?.store !== undefined,
    });
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
 * Each runs in a process group of its own, so a terminal's ctrl-c reaches this process alone (on
 * Windows, which has no groups, it reaches them too), and its `stop` is the one path that ends them. The company's own Postgres, when neither the
 * environment nor `.env` names a URL, is this process's (`withPostgres`, the config unread: one
 * the config names is the child's), so a restart keeps it; the child inherits its URL.
 */
async function dev(repo: string, packages: readonly LinkedPackage[]): Promise<never> {
  const { buildDirs, startWatchers, supervise, whenUnlinked } = await import("./dev.ts");
  const cwd = process.cwd();
  log(`dev mode: ${repo}; building ${packages.map((p) => p.name).join(", ") || "nothing"} as it changes`);
  const dotenv = join(cwd, ".env");
  const named =
    process.env.SANOMA_DATABASE_URL ||
    (existsSync(dotenv) && parseEnv(readFileSync(dotenv, "utf8")).SANOMA_DATABASE_URL);
  const postgres = named ? undefined : await withPostgres(undefined, cwd, true, { adopt: true });
  const watchers = startWatchers(packages, log);
  const cli = fileURLToPath(import.meta.url);
  const sanoma = packages.find((p) => p.name === "sanoma");
  const { siteBuild } = await import("./sites.ts");
  // A linked app with no build yet is not hot: every change restarts the child until it builds.
  const hot = sanoma && (await siteBuild(cwd).catch(() => undefined))?.sitesOf(cwd).sites.length;
  const child = supervise({
    spawn: () =>
      // With SANOMA_EVENTS=1, a stdin of its own that nothing writes: the end of this process's
      // stdin stops this process, which ends the child; the child's ends when this process does.
      spawn(process.execPath, [cli, "serve", "--dev"], {
        cwd,
        env: process.env,
        stdio: [eventsOn() ? "pipe" : "inherit", "inherit", "inherit"],
        // On Windows `detached` means a console window of its own.
        detached: process.platform !== "win32",
        windowsHide: true,
      }),
    watch: packages.flatMap(buildDirs),
    ignore: hot ? ["client", "server"].map((dir) => join(sanoma.dir, "app", "dist", dir)) : [],
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
  // Once the repo is unlinked (`sanoma dev unlink`, an install), the checkout's server must not
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
  const { describeConfig, readPeople, schemaOf, writeGenerated } = await import("sanoma/workflows/describe");
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
 * `sanoma wakeup`: the wakeup service on the config's database, which it only finds running, as
 * `worker` and `app` do, on `SANOMA_APP_HOST` and `SANOMA_APP_PORT` (default 3100). The config is
 * read for its database alone.
 */
async function wakeupCommand(): Promise<never> {
  const loaded = await loadConfig();
  const postgres = await withPostgres(namedDatabaseUrl(loaded.config), loaded.root, false);
  let served: Listening;
  try {
    const { runWakeup } = await import("./wakeup.ts");
    const host = process.env.SANOMA_APP_HOST || "127.0.0.1";
    served = await runWakeup(postgres.databaseUrl, { host, port: port(3100), log });
  } catch (err) {
    await postgres.stop().catch(() => {});
    throw err;
  }
  console.log(`the wakeup service at ${served.url}; ctrl-c to stop`);
  emit({ event: "ready", url: served.url, sites: {} });
  onSignal(() => served.stop().finally(() => postgres.stop()));
  return new Promise(() => {});
}

/**
 * `sanoma wakeup account <label>`: an account of the wakeup service on the config's database (found
 * as `sanoma wakeup` finds it), its token shown this once, as the one JSON line on stdout.
 */
async function wakeupAccount(label: string): Promise<number> {
  const loaded = await loadConfig();
  const postgres = await withPostgres(namedDatabaseUrl(loaded.config), loaded.root, false, { announce: false });
  try {
    const { mintWakeupAccount } = await import("sanoma/workflows/wakeup-service");
    console.log(JSON.stringify(await mintWakeupAccount(postgres.databaseUrl, label)));
    return 0;
  } finally {
    await postgres.stop();
  }
}

/**
 * On the first SIGINT or SIGTERM, or with `SANOMA_EVENTS=1` the end of stdin (a parent process
 * gone, or done), stops what runs and exits 0; a second signal exits at once. Not with the variable:
 * the parent has its own deadline, and it may be the same stop reaching this process twice (`pnpm dlx
 * sanoma` passes on a signal its process group got too), which must not leave Postgres running.
 * Without the variable stdin is never read. Returns what stops, once, for a caller with a reason of
 * its own to stop (what it runs is done): as a signal stops, exiting 1 when given the `failure`
 * that ended it (logged), else 0; a signal while that stop runs exits at once with the same code.
 */
function onSignal(stop: () => Promise<void>): (failure?: { error: unknown }) => void {
  let stopping = false;
  // Set by a stop of the caller's own: a signal during it is no reason of its own to stop.
  let own: { code: number } | undefined;
  const stopOnce = () => {
    if (stopping) return;
    stopping = true;
    stop().then(
      () => process.exit(own?.code ?? 0),
      (err: unknown) => {
        fail(err);
        // Once stdout has taken the line: a pipe's writes are asynchronous on macOS.
        process.stdout.write("", () => process.exit(1));
      },
    );
  };
  const handle = () => {
    if (!stopping) stopOnce();
    else if (!eventsOn()) process.exit(own?.code ?? 130);
  };
  // `on`, not `once`: the second signal must find the handler still there, and a dependency's
  // signal-exit (Pi's, in the app) re-sends a signal it finds no other listener for, which would
  // kill the process before `stop` ends.
  process.on("SIGINT", handle);
  process.on("SIGTERM", handle);
  if (eventsOn()) process.stdin.once("end", stopOnce).once("error", stopOnce).resume();
  return (failure) => {
    if (stopping) return;
    if (failure) fail(failure.error);
    own = { code: failure ? 1 : 0 };
    stopOnce();
  };
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    fail(err);
    process.exitCode = err instanceof UsageError ? USAGE_EXIT : 1;
  }
}
