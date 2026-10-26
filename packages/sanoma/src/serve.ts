import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type AppOptions, githubLogin, type IngressRoute, startApp } from "@sanoma-ai/app";
import {
  declaredWakeup,
  errorMessage,
  isLoopback,
  type ResolvedConfig,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  startWorker,
  superviseWorker,
  wakeGeneration,
} from "@sanoma-ai/workflows";
import { describeConfig, readPeople, schemaOf, writeGenerated } from "@sanoma-ai/workflows/describe";
import { domainsOf } from "@sanoma-ai/workflows/shared";
import type { WakeupService } from "@sanoma-ai/workflows/wakeup-service";
import { UsageError } from "./config.ts";
import { runtimeFrom, siteBuild } from "./sites.ts";
import { localGitSource } from "./source.ts";

export interface Stoppable {
  stop(): Promise<void>;
}

export interface Served extends Stoppable {
  /** Where the app listens, such as `http://127.0.0.1:3000`. */
  url: string;
  /** Each public site, by name, at its own host on this machine: `http://www.localhost:3000` (`App.sites`). */
  sites: Record<string, string>;
}

/** The checkout the config was loaded from (`loadConfig` sets its `file`). */
const rootOf = (config: SanomaConfig) => config.root ?? dirname(config.file!);

/** The checkout, as the worker's and the app's `source`. */
const sourceOf = (config: SanomaConfig) => localGitSource(rootOf(config));

/** What a worker of the launcher's starts with: promoted, since a local worker is always the version to take queued runs, even one seen before, and the checkout as its source. */
const workerOptions = (config: SanomaConfig) => ({ promote: true, source: sourceOf(config) });

/**
 * Starts the worker, for `sanoma worker`: it never stops itself, since nothing in this process
 * would start it again (no app hears a write or a wake). `serve` supervises its own.
 */
export async function runWorker(config: SanomaConfig): Promise<Stoppable> {
  const worker = await startWorker(config, workerOptions(config));
  return { stop: () => worker.stop() };
}

export interface ServeOptions {
  /** The app's port: 0 for any free port. */
  port: number;
  /** Receives what the sites' build has to say. */
  log: (line: string) => void;
  /** With sites, serve them from Vite's dev server, edits showing as they are saved, instead of building them. */
  dev?: boolean;
  /** The config, resolved, when the caller has it: the Cedar schema is made from it. */
  resolved?: ResolvedConfig;
  /**
   * Ends the process as SIGTERM does (the launcher's signal path), for the exit rule
   * (`exitRule`). Without it the process never ends by itself.
   */
  exit?: () => void;
  /** How long the app goes without a request, the worker stopped, before the exit rule ends the process: 10 minutes by default. */
  quietExitMs?: number;
}

/** The wakeup's route's: what it hands each generation to, and where a failure of that is said. */
export interface WakeRouteOptions {
  /** Called with the generation of each `GET /wake` the app answers. Default: nothing. */
  onWake?: (generation: number) => void | Promise<void>;
  log: (line: string) => void;
}

/** Starts the app on `port`, with the host and login `appOptions` reads, and the sites built; `url` says where. */
export async function runApp(config: SanomaConfig, options: ServeOptions): Promise<Served> {
  return served(config, await appStart(config, options), []);
}

/**
 * The wakeup's `GET /wake?generation=N`, a machine route with no login: a `generation` that is a
 * non-negative integer is handed to `onWake` and answered 204, a stale one too (a wake is
 * harmless: the worker decides what it starts); any other is 400. `onWake` throwing or rejecting is logged,
 * never the wakeup's failure.
 */
export function wakeRoute({ onWake, log }: WakeRouteOptions): IngressRoute {
  return {
    method: "GET",
    path: "/wake",
    async handle(request) {
      const generation = wakeGeneration(request.url);
      if (generation === undefined) {
        return new Response("generation must be a non-negative integer\n", {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
      const failed = (err: unknown) => log(`a wake of generation ${generation} failed: ${errorMessage(err)}`);
      try {
        // Not awaited: the wakeup's answer never waits on what the wake starts.
        void Promise.resolve(onWake?.(generation)).catch(failed);
      } catch (err) {
        failed(err);
      }
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    },
  };
}

/**
 * What the app starts with: the port, the host and login `appOptions` reads, and what it serves
 * (`appSites`); the generated files written first (`writeGenerated`: `.sanoma/api.ts` and the
 * Cedar schema), for an editor, the sites and the policies' author.
 */
async function appStart(
  config: SanomaConfig,
  { port, log, dev = false, resolved = resolveConfig(config) }: ServeOptions,
): Promise<AppOptions> {
  const options = { port, ...(await appOptions(secretsOf(config))) };
  // For an editor and the sites' types only: a checkout it cannot write still serves.
  await writeGenerated(
    rootOf(config),
    describeConfig(config),
    schemaOf(resolved, readPeople(rootOf(config)).people),
  ).catch((err: unknown) => log(`could not write .sanoma/: ${errorMessage(err)}`));
  const sites = await appSites(rootOf(config), log, dev ? options.host : false);
  return { ...options, ...sites, ...(sites.dev && { dev: { ...sites.dev, onFileChange: apiWriter(config, log) } }) };
}

/** Starts the app with `options`, the checkout as its source, and the machine routes `ingress` (`/wake`). */
async function served(config: SanomaConfig, options: AppOptions, ingress: IngressRoute[]): Promise<Served> {
  const app = await startApp(config, { ...options, source: sourceOf(config), ingress });
  return { url: app.url, sites: app.sites, stop: () => app.close() };
}

/**
 * What the app serves: with sites, its own build of the app and every site, built into
 * `.sanoma/app/build/<key>` or reused when the key matches, or with `dev` (the app's host, when
 * it is this machine's) the app and the sites on Vite's dev server; with none, the build the app
 * ships. A folder that is not a site for its name is logged and left out.
 */
async function appSites(
  root: string,
  log: (line: string) => void,
  dev: string | undefined | false,
): Promise<Pick<AppOptions, "distDir" | "dev">> {
  const build = await siteBuild(root);
  if (!build) return {};
  const { sites, refused } = build.sitesOf(root);
  const named = `${sites.length} site${sites.length === 1 ? "" : "s"} (${sites.join(", ")})`;
  // The dev server listens on this machine only.
  const hot = dev !== false && (dev === undefined || isLoopback(dev));
  if (sites.length && !hot) {
    if (dev) log(`SANOMA_APP_HOST=${dev} is not this machine: the sites are built, not served hot`);
    log(`building the app with ${named}`);
    const { distDir, built } = await build.buildApp(root, { log, runtimeFrom: runtimeFrom() });
    if (!built) log("app build up to date");
    return { distDir };
  }
  // buildApp says the same of each when there is a build to run.
  for (const name of refused) {
    log(`sites/${name} is not mounted: a site's folder name is a URL segment (lowercase letters, digits and dashes)`);
  }
  if (!sites.length) return {};
  log(`serving the app with ${named} from Vite's dev server: edits show as they are saved`);
  return { dev: { repo: root } };
}

/** Where a change cannot reach the config from: the sites, what sanoma writes, the install, git. */
const NOT_CONFIG = new Set(["sites", ".sanoma", "node_modules", ".git"]);

/**
 * Writes the generated files again on a change to a file the config may be read from: the config's
 * own, or TypeScript under the root outside `NOT_CONFIG` (a workflow may import a relative file
 * anywhere). In a child `sanoma api`, in the config's directory, where it loads the config: this
 * process holds the config as it was loaded, and Node imports a module once. One child at a time;
 * changes while one runs are one more run after it.
 */
function apiWriter(config: SanomaConfig, log: (line: string) => void): (file: string) => void {
  const cli = fileURLToPath(new URL(`./cli${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
  // By real path, as the dev server's watcher names files.
  const root = realpathSync(rootOf(config));
  const cwd = config.file ? dirname(config.file) : root;
  const readsConfig = (file: string) => {
    if (file === config.file) return true;
    const path = relative(root, file);
    return /\.tsx?$/.test(path) && !path.startsWith("..") && !isAbsolute(path) && !NOT_CONFIG.has(path.split(sep)[0]!);
  };
  let running = false;
  let again = false;
  const run = () => {
    running = true;
    again = false;
    // Not a launcher: its failure is no `error` event for a parent process (SANOMA_EVENTS).
    spawn(process.execPath, [cli, "api"], { cwd, stdio: "inherit", env: { ...process.env, SANOMA_EVENTS: undefined } })
      .once("error", (err) => log(`could not write .sanoma/: ${err.message}`))
      .once("close", () => {
        running = false;
        if (again) run();
      });
  };
  return (file) => {
    if (!readsConfig(file)) return;
    if (running) again = true;
    else run();
  };
}

const GITHUB = ["SANOMA_GITHUB_CLIENT_ID", "SANOMA_GITHUB_CLIENT_SECRET"] as const;

/** Reads stored secrets by name (`SanomaClient.secrets`): the values found, the environment's first. */
export type ReadSecrets = (names: string[]) => Promise<Map<string, string>>;

/** The config's stored secrets, through a client opened for the read. */
const secretsOf =
  (config: SanomaConfig): ReadSecrets =>
  async (names) => {
    const client = await SanomaClient.connect(config);
    try {
      return new Map([...(await client.secrets(names))].map(([name, { value }]) => [name, value]));
    } finally {
      await client.close();
    }
  };

/**
 * `SANOMA_DOMAINS`, a public site's domain by its name: `<site>=<hostname>[,<site>=<hostname>…]`,
 * as a host resource's `domains` sets it (`www=sanoma.example`); unset or empty, none. A
 * malformed one is a UsageError.
 */
export function parseDomains(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    return domainsOf(value);
  } catch (err) {
    throw new UsageError(errorMessage(err));
  }
}

/**
 * The app's host (`SANOMA_APP_HOST`, default 127.0.0.1), the public sites' domains
 * (`SANOMA_DOMAINS`, `parseDomains`) and, when the `SANOMA_GITHUB_*` variables are set, GitHub
 * sign-in; both or neither, and any host but this machine needs it. An empty value is the same
 * as unset. On a host beyond this machine, or with one of them set, one the environment leaves
 * unset is read from the stored secrets (`readSecrets`), where creating the GitHub App on the
 * app's connect page put them. A mistake in them is a UsageError.
 */
export async function appOptions(readSecrets?: ReadSecrets): Promise<Pick<AppOptions, "host" | "login" | "domains">> {
  const env = process.env;
  const domains = parseDomains(env.SANOMA_DOMAINS);
  const host = env.SANOMA_APP_HOST || undefined;
  const options = { host, ...(domains && { domains }) };
  const beyond = host !== undefined && !isLoopback(host);
  const found = new Map<string, string>(GITHUB.flatMap((name) => (env[name] ? [[name, env[name]]] : [])));
  if ((beyond || found.size) && readSecrets && found.size < GITHUB.length) {
    const stored = await readSecrets([...GITHUB]).catch((err: unknown) => {
      throw new UsageError(`GitHub sign-in could not read the stored client id and secret: ${errorMessage(err)}`);
    });
    for (const [name, value] of stored) if (value && !found.has(name)) found.set(name, value);
  }
  const [clientId, clientSecret] = GITHUB.map((name) => found.get(name));
  if (!clientId && !clientSecret) {
    if (beyond) throw new UsageError(`SANOMA_APP_HOST=${host} needs GitHub sign-in: set ${GITHUB.join(", ")}`);
    return options;
  }
  if (!clientId || !clientSecret) {
    const missing = GITHUB.filter((name) => !found.has(name));
    throw new UsageError(`GitHub sign-in needs ${GITHUB.join(", ")}: ${missing.join(", ")} not set`);
  }
  try {
    return { ...options, login: githubLogin({ clientId, clientSecret }) };
  } catch (err) {
    throw new UsageError(errorMessage(err));
  }
}

/**
 * What `quietExit` is told of the process: when a request arrives (the function it returns, when
 * its response closes), and when the worker stopped itself; `close` ends it.
 */
export interface QuietExit {
  request(): () => void;
  stopped(): void;
  close(): void;
}

/**
 * Calls `exit` once, when `stopped()` says the worker stopped itself, no request is open, and
 * none has arrived or ended for `quietMs`: looked at when the worker stops (`QuietExit.stopped`)
 * or the last open request ends, then again when the quiet would end. Its one timer never holds
 * the process up.
 */
export function quietExit({
  quietMs,
  stopped,
  exit,
}: {
  quietMs: number;
  stopped: () => boolean;
  exit: () => void;
}): QuietExit {
  let last = Date.now();
  // Requests whose responses have not closed: a stream of the agent's chat among them.
  let open = 0;
  let timer: NodeJS.Timeout | undefined;
  let done = false;
  const look = () => {
    clearTimeout(timer);
    timer = undefined;
    if (done || open > 0 || !stopped()) return;
    const left = last + quietMs - Date.now();
    if (left > 0) timer = setTimeout(look, left).unref();
    else {
      done = true;
      exit();
    }
  };
  return {
    request() {
      last = Date.now();
      open++;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        open--;
        last = Date.now();
        look();
      };
    },
    stopped: look,
    close() {
      done = true;
      clearTimeout(timer);
    },
  };
}

/**
 * The exit rule, when the host the declared wakeup names stops the instance when its process
 * exits (`stops-on-exit`): `quietExit`, for `quietExitMs` (10 minutes by default), ending the
 * process through `exit`, so the host stops the instance and its next request starts it again.
 * None without `exit`, or on any other host (one that stops when quiet stops the instance itself,
 * a long-lived one never does).
 */
async function exitRule(
  config: SanomaConfig,
  stopped: () => boolean,
  { exit, quietExitMs = 600_000 }: ServeOptions,
): Promise<QuietExit | undefined> {
  if (!exit) return undefined;
  const lifetime = (await declaredWakeup(config))?.host?.type.host?.capabilities.lifetime;
  return lifetime === "stops-on-exit" ? quietExit({ quietMs: quietExitMs, stopped, exit }) : undefined;
}

/**
 * The sites' build, the worker under a supervisor (`superviseWorker`), the wakeup service when
 * the config runs it (`wakeup: true`), then the app, serving `/wake` and the service's routes, in
 * this process. A worker that stopped itself starts again on a wake its generation names, or on
 * a write from the app (`AppOptions.onWrite`: a run's start, an approval's decision), never on
 * a page read; the exit rule (`exitRule`) ends the process on a host that stops it on exit.
 * `stop` stops the app, the service, then the worker.
 */
export async function serve(config: SanomaConfig, serveOptions: ServeOptions): Promise<Served> {
  // Read and built before the worker starts, so a mistake in the variables or a site starts nothing.
  const options = await appStart(config, serveOptions);
  const { log } = serveOptions;
  // An app on this machine alone is not the instance the host runs: its worker never stops
  // itself (its wakeup would wake that instance), and it never exits when quiet.
  const here = isLoopback(options.host ?? "127.0.0.1");
  // Asked only once the worker stopped itself, after `supervised` is set.
  const rule = here ? undefined : await exitRule(config, () => supervised.stopped, serveOptions);
  const supervised = await superviseWorker(config, {
    ...workerOptions(config),
    selfStop: !here,
    ...(rule && { onStopped: rule.stopped }),
  });
  let wakeup: WakeupService | undefined;
  let app: Served;
  try {
    if (config.wakeup === true) {
      const { databaseUrl } = serveOptions.resolved ?? resolveConfig(config);
      const { startWakeupService } = await import("@sanoma-ai/workflows/wakeup-service");
      wakeup = await startWakeupService({ databaseUrl, log: { info: log, warn: log } });
    }
    app = await served(
      config,
      { ...options, onWrite: () => void supervised.resume(), ...(rule && { onRequest: rule.request }) },
      [wakeRoute({ log, onWake: (generation) => supervised.wake(generation) }), ...(wakeup?.routes ?? [])],
    );
  } catch (err) {
    rule?.close();
    await wakeup?.stop().catch(() => {});
    await supervised.stop().catch(() => {});
    throw err;
  }
  return {
    url: app.url,
    sites: app.sites,
    async stop() {
      rule?.close();
      try {
        await app.stop();
      } finally {
        try {
          await wakeup?.stop();
        } finally {
          await supervised.stop();
        }
      }
    },
  };
}
