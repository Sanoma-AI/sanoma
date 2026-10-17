import { type AppOptions, githubLogin, startApp } from "@sanoma-ai/app";
import { errorMessage, isLoopback, type SanomaConfig, startWorker } from "@sanoma-ai/workflows";
import { UsageError } from "./config.ts";

export interface Stoppable {
  stop(): Promise<void>;
}

export interface Served extends Stoppable {
  /** Where the app listens, such as `http://127.0.0.1:3000`. */
  url: string;
}

/** Starts the worker, promoted: a local worker is always the version to take queued runs, even one seen before. */
export async function runWorker(config: SanomaConfig): Promise<Stoppable> {
  const worker = await startWorker(config, { promote: true });
  return { stop: () => worker.stop() };
}

/** Starts the app on `port` (0 for any free port), with the host and login `appOptions` reads; `url` says where. */
export async function runApp(config: SanomaConfig, { port }: { port: number }): Promise<Served> {
  return served(config, { port, ...appOptions() });
}

async function served(config: SanomaConfig, options: AppOptions): Promise<Served> {
  const app = await startApp(config, options);
  return { url: app.url, stop: () => app.close() };
}

const GITHUB = ["SANOMA_GITHUB_CLIENT_ID", "SANOMA_GITHUB_CLIENT_SECRET", "SANOMA_GITHUB_REPO"] as const;

/**
 * The app's host (`SANOMA_APP_HOST`, default 127.0.0.1) and, when the `SANOMA_GITHUB_*` variables
 * are set, GitHub sign-in; all three or none, and any host but this machine needs it. An empty
 * value is the same as unset. A mistake in them is a UsageError.
 */
export function appOptions(): Pick<AppOptions, "host" | "login"> {
  const env = process.env;
  const host = env.SANOMA_APP_HOST || undefined;
  const [clientId, clientSecret, repo] = GITHUB.map((name) => env[name]);
  if (!clientId && !clientSecret && !repo) {
    if (host && !isLoopback(host)) {
      throw new UsageError(`SANOMA_APP_HOST=${host} needs GitHub sign-in: set ${GITHUB.join(", ")}`);
    }
    return { host };
  }
  if (!clientId || !clientSecret || !repo) {
    const missing = GITHUB.filter((name) => !env[name]);
    throw new UsageError(`GitHub sign-in needs ${GITHUB.join(", ")}: ${missing.join(", ")} not set`);
  }
  try {
    return { host, login: githubLogin({ clientId, clientSecret, repo }) };
  } catch (err) {
    throw new UsageError(errorMessage(err));
  }
}

/** The worker first, then the app, in this process; `stop` stops the app, then the worker. */
export async function serve(config: SanomaConfig, { port }: { port: number }): Promise<Served> {
  // Read before the worker starts, so a mistake in the variables starts nothing.
  const options = { port, ...appOptions() };
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
