import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type AppOptions, type IngressRoute, staffLogin, startApp } from "sanoma/app";
import { appSteps } from "sanoma/app/steps";
import { betterAuthStaffLogin, prepareBetterAuthStaff } from "sanoma/better-auth";
import {
  deploymentKey,
  errorMessage,
  GITHUB_APP,
  isLoopback,
  type ResolvedConfig,
  resolveConfig,
  resolveDatabaseUrl,
  SanomaClient,
  type SanomaConfig,
  superviseWorker,
} from "sanoma/workflows";
import { describeConfig, readPeople, schemaOf, writeGenerated } from "sanoma/workflows/describe";
import { domainsOf, UsageError } from "sanoma/workflows/shared";
import type { WakeupService } from "sanoma/workflows/wakeup-service";
import { loadConfig } from "./config.ts";
import { siteBuild } from "./sites.ts";
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
export const rootOf = (config: SanomaConfig) => config.root ?? dirname(config.file!);

/** The checkout, as the worker's and the app's `source`, a draft's check on the config's database. */
const sourceOf = (config: SanomaConfig) => localGitSource(rootOf(config), { databaseUrl: resolveDatabaseUrl(config) });

/**
 * What a worker of the launcher's starts with: promoted, since a local worker is always the
 * version to take queued runs, even one seen before; the checkout as its source; the app's steps,
 * which the app's built-in workflows run (Adopt, Save, going live, connecting, a chat's turn); and the staff
 * login's tables among what it prepares, since no config names that login (`appOptions` makes it).
 */
export const workerOptions = (config: SanomaConfig) => ({
  promote: true,
  source: sourceOf(config),
  app: appSteps,
  prepare: [prepareBetterAuthStaff],
});

export interface ServeOptions {
  /** The app's port: 0 for any free port. */
  port: number;
  /** Receives what the sites' build has to say. */
  log: (line: string) => void;
  /** With sites, serve them from Vite's dev server, edits showing as they are saved, instead of building them. */
  dev?: boolean;
  /** The config, resolved, when the caller has it: the Cedar schema is made from it. */
  resolved?: ResolvedConfig;
}

/** The wakeup's route's: what it hands each wake to, and where a failure of that is said. */
export interface WakeRouteOptions {
  /** Called for each `GET /wake` the app answers. Default: nothing. */
  onWake?: () => void | Promise<void>;
  log: (line: string) => void;
}

/** Starts the app on `port`, with the host and login `appOptions` reads, and the sites built; `url` says where. */
export async function runApp(config: SanomaConfig, options: ServeOptions): Promise<Served> {
  return served(config, await appStart(config, options), []);
}

/**
 * The wakeup's `GET /wake`, a machine route with no login: handed to `onWake` and answered 204,
 * always (a wake is "resume if stopped": one late, twice or for a replaced registration starts a
 * worker that finds nothing to do). `onWake` throwing or rejecting is logged, never the wakeup's failure.
 */
export function wakeRoute({ onWake, log }: WakeRouteOptions): IngressRoute {
  return {
    method: "GET",
    path: "/wake",
    async handle() {
      // Not awaited: the wakeup's answer never waits on what the wake starts.
      void (async () => onWake?.())().catch((err: unknown) => log(`a wake failed: ${errorMessage(err)}`));
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
    const { distDir, built } = await build.buildApp(root, { log });
    if (!built) log("app build up to date");
    return { distDir };
  }
  // buildApp says the same of each when there is a build to run.
  for (const dir of refused) {
    log(`${dir} is not mounted: a site's folder name is a URL segment (lowercase letters, digits and dashes)`);
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

/** The GitHub App's client the staff login signs in with, as the app's Connect page stores it. */
const GITHUB = [GITHUB_APP.client_id, GITHUB_APP.client_secret] as const;

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
 * (`SANOMA_DOMAINS`, `parseDomains`) and its login: on this machine the loopback picker (the
 * app's default); on any other host the staff login (`staffLogin` over Better Auth), which needs
 * `SANOMA_SIGNING_KEY`, with GitHub as a method when `SANOMA_GITHUB_CLIENT_ID` and
 * `SANOMA_GITHUB_CLIENT_SECRET` are both set, in the environment or in the stored secrets
 * (`readSecrets`), where creating the GitHub App on the app's connect page put them; the same
 * client goes to the public sites' logins (`social`), for visitors. An empty value is the same as
 * unset. A mistake in them is a UsageError.
 */
export async function appOptions(
  readSecrets?: ReadSecrets,
): Promise<Pick<AppOptions, "host" | "login" | "domains" | "social">> {
  const env = process.env;
  const domains = parseDomains(env.SANOMA_DOMAINS);
  const host = env.SANOMA_APP_HOST || undefined;
  const options = { host, ...(domains && { domains }) };
  if (host === undefined || isLoopback(host)) return options;
  try {
    deploymentKey("SANOMA_SIGNING_KEY");
  } catch (err) {
    throw new UsageError(`SANOMA_APP_HOST=${host} signs people in, which ${errorMessage(err)}`);
  }
  const found = new Map<string, string>(GITHUB.flatMap((name) => (env[name] ? [[name, env[name]]] : [])));
  if (readSecrets && found.size < GITHUB.length) {
    const stored = await readSecrets([...GITHUB]).catch((err: unknown) => {
      throw new UsageError(`GitHub sign-in could not read the stored client id and secret: ${errorMessage(err)}`);
    });
    for (const [name, value] of stored) if (value && !found.has(name)) found.set(name, value);
  }
  const [clientId, clientSecret] = GITHUB.map((name) => found.get(name));
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    const missing = GITHUB.filter((name) => !found.has(name));
    throw new UsageError(`GitHub sign-in needs ${GITHUB.join(", ")}: ${missing.join(", ")} not set`);
  }
  const social = clientId && clientSecret ? { github: { clientId, clientSecret } } : undefined;
  return { ...options, login: staffLogin(betterAuthStaffLogin, social), social };
}

/** How long a reload waits after it is asked (`WorkerOptions.reload`): the save that asked it ends first. */
const RELOAD_MS = 1_000;

/**
 * The sites' build, the worker under a supervisor (`superviseWorker`), the wakeup service when
 * the config runs it (`wakeup: true`), then the app, serving `/wake` and the service's routes, in
 * this process. A worker that stopped itself starts again on a wake, or on a write from the app
 * (`AppOptions.onWrite`: a run's start, an approval's decision), never on a page read. A draft
 * saved into the checkout asks the worker to reload (`WorkerOptions.reload`): a moment later the
 * company's files are loaded again (`loadConfig`'s `fresh`) and, once they resolve, the app and
 * the worker stop and start again on them, the app on the same port; files that do not load or
 * resolve are logged and change nothing, and ones that fail to start are logged and the old
 * started again in their place. `stop` stops the app, the service, then the worker.
 */
export async function serve(config: SanomaConfig, serveOptions: ServeOptions): Promise<Served> {
  // Read and built before the worker starts, so a mistake in the variables or a site starts nothing.
  const options = await appStart(config, serveOptions);
  /** What the app runs with now: `options`, then a reload's. */
  let current = options;
  const { log } = serveOptions;
  // An app on this machine alone is not the instance the host runs: its worker never stops
  // itself (its wakeup would wake that instance).
  const here = isLoopback(options.host ?? "127.0.0.1");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reloading = Promise.resolve();
  const reload = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      reloading = reloading
        .then(restart)
        .catch((err: unknown) => log(`could not start again on the saved files: ${errorMessage(err)}`));
    }, RELOAD_MS);
  };
  const supervise = (files: SanomaConfig) =>
    superviseWorker(files, { ...workerOptions(files), selfStop: !here, reload });
  let supervised = await supervise(config);
  let wakeup: WakeupService | undefined;
  const start = (files: SanomaConfig, started: AppOptions) =>
    served(files, { ...started, onWrite: () => void supervised.resume() }, [
      wakeRoute({ log, onWake: () => supervised.wake() }),
      ...(wakeup?.routes ?? []),
    ]);
  let app: Served;
  try {
    if (config.wakeup === true) {
      const { databaseUrl } = serveOptions.resolved ?? resolveConfig(config);
      const { startWakeupService } = await import("sanoma/workflows/wakeup-service");
      wakeup = await startWakeupService({ databaseUrl, log: { info: log, warn: log } });
    }
    app = await start(config, options);
  } catch (err) {
    await wakeup?.stop().catch(() => {});
    await supervised.stop().catch(() => {});
    throw err;
  }
  const restart = async () => {
    const { config: next } = await loadConfig(dirname(config.file!), { fresh: true });
    const resolved = resolveConfig(next);
    if (resolved.policyProblems.length)
      throw new Error(`the policies do not hold: ${resolved.policyProblems.join("; ")}`);
    const port = Number(new URL(app.url).port);
    const nextOptions = await appStart(next, { ...serveOptions, port, resolved });
    await app.stop();
    await supervised.stop();
    try {
      supervised = await supervise(next);
      app = await start(next, nextOptions);
    } catch (err) {
      // Started again on the files as they were, which ran a moment ago.
      await supervised.stop().catch(() => {});
      supervised = await supervise(config);
      app = await start(config, { ...current, port });
      throw err;
    }
    config = next;
    current = nextOptions;
    log(`${resolved.appName} started again on the saved files`);
  };
  return {
    get url() {
      return app.url;
    },
    get sites() {
      return app.sites;
    },
    async stop() {
      clearTimeout(timer);
      await reloading;
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
