import { dirname } from "node:path";
import { type AppOptions, githubLogin, startApp } from "@sanoma-ai/app";
import { errorMessage, isLoopback, SanomaClient, type SanomaConfig, startWorker } from "@sanoma-ai/workflows";
import { UsageError } from "./config.ts";
import { runtimeFrom, siteBuild } from "./sites.ts";
import { localGitSource } from "./source.ts";

export interface Stoppable {
  stop(): Promise<void>;
}

export interface Served extends Stoppable {
  /** Where the app listens, such as `http://127.0.0.1:3000`. */
  url: string;
}

/** The checkout the config was loaded from (`loadConfig` sets its `file`). */
const rootOf = (config: SanomaConfig) => config.root ?? dirname(config.file!);

/** The checkout, as the worker's and the app's `source`. */
const sourceOf = (config: SanomaConfig) => localGitSource(rootOf(config));

/** Starts the worker, promoted: a local worker is always the version to take queued runs, even one seen before. */
export async function runWorker(config: SanomaConfig): Promise<Stoppable> {
  const worker = await startWorker(config, { promote: true, source: sourceOf(config) });
  return { stop: () => worker.stop() };
}

export interface ServeOptions {
  /** The app's port: 0 for any free port. */
  port: number;
  /** Receives what the sites' build has to say. */
  log: (line: string) => void;
}

/** Starts the app on `port`, with the host and login `appOptions` reads, and the sites built; `url` says where. */
export async function runApp(config: SanomaConfig, options: ServeOptions): Promise<Served> {
  return served(config, await appStart(config, options));
}

/** What the app starts with: the port, the host and login `appOptions` reads, and the build it serves (`appBuilt`). */
async function appStart(config: SanomaConfig, { port, log }: ServeOptions): Promise<AppOptions> {
  const options = { port, ...(await appOptions(secretsOf(config))) };
  return { ...options, distDir: await appBuilt(rootOf(config), log) };
}

async function served(config: SanomaConfig, options: AppOptions): Promise<Served> {
  const app = await startApp(config, { ...options, source: sourceOf(config) });
  return { url: app.url, stop: () => app.close() };
}

/**
 * The app the repo serves: with sites, its own build of the app and every site, built into
 * `.sanoma/app/build/<key>` or reused when the key matches; with none, `undefined`, the build the
 * app ships. A folder that is not a site for its name is logged and left out.
 */
async function appBuilt(root: string, log: (line: string) => void): Promise<string | undefined> {
  const build = await siteBuild(root);
  if (!build) return undefined;
  const { sites, refused } = build.sitesOf(root);
  if (!sites.length) {
    // buildApp says the same of each when there is a build to run.
    for (const name of refused) {
      log(`sites/${name} is not mounted: a site's folder name is a URL segment (lowercase letters, digits and dashes)`);
    }
    return undefined;
  }
  const named = `${sites.length} site${sites.length === 1 ? "" : "s"} (${sites.join(", ")})`;
  log(`building the app with ${named}`);
  const { distDir, built } = await build.buildApp(root, { log, runtimeFrom: runtimeFrom() });
  if (!built) log("app build up to date");
  return distDir;
}

const GITHUB = ["SANOMA_GITHUB_CLIENT_ID", "SANOMA_GITHUB_CLIENT_SECRET", "SANOMA_GITHUB_REPO"] as const;
const CLIENT = GITHUB.slice(0, 2);

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
 * The app's host (`SANOMA_APP_HOST`, default 127.0.0.1) and, when the `SANOMA_GITHUB_*` variables
 * are set, GitHub sign-in; all three or none, and any host but this machine needs it. An empty
 * value is the same as unset. With the repository set, a client id or secret the environment
 * leaves unset is read from the stored secrets (`readSecrets`), where creating the GitHub App on
 * the app's connect page put them. A mistake in them is a UsageError.
 */
export async function appOptions(readSecrets?: ReadSecrets): Promise<Pick<AppOptions, "host" | "login">> {
  const env = process.env;
  const host = env.SANOMA_APP_HOST || undefined;
  const found = new Map<string, string>(GITHUB.flatMap((name) => (env[name] ? [[name, env[name]]] : [])));
  if (found.has("SANOMA_GITHUB_REPO") && readSecrets && CLIENT.some((name) => !found.has(name))) {
    const stored = await readSecrets(CLIENT).catch((err: unknown) => {
      throw new UsageError(`GitHub sign-in could not read the stored client id and secret: ${errorMessage(err)}`);
    });
    for (const [name, value] of stored) if (value) found.set(name, value);
  }
  const [clientId, clientSecret, repo] = GITHUB.map((name) => found.get(name));
  if (!clientId && !clientSecret && !repo) {
    if (host && !isLoopback(host)) {
      throw new UsageError(`SANOMA_APP_HOST=${host} needs GitHub sign-in: set ${GITHUB.join(", ")}`);
    }
    return { host };
  }
  if (!clientId || !clientSecret || !repo) {
    const missing = GITHUB.filter((name) => !found.has(name));
    throw new UsageError(`GitHub sign-in needs ${GITHUB.join(", ")}: ${missing.join(", ")} not set`);
  }
  try {
    return { host, login: githubLogin({ clientId, clientSecret, repo }) };
  } catch (err) {
    throw new UsageError(errorMessage(err));
  }
}

/** The sites' build, the worker, then the app, in this process; `stop` stops the app, then the worker. */
export async function serve(config: SanomaConfig, serveOptions: ServeOptions): Promise<Served> {
  // Read and built before the worker starts, so a mistake in the variables or a site starts nothing.
  const options = await appStart(config, serveOptions);
  const worker = await runWorker(config);
  let app: Served;
  try {
    app = await served(config, options);
  } catch (err) {
    await worker.stop().catch(() => {});
    throw err;
  }
  return {
    url: app.url,
    async stop() {
      try {
        await app.stop();
      } finally {
        await worker.stop();
      }
    },
  };
}
