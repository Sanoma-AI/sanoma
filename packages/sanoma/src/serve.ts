import { type AppOptions, githubLogin, startApp } from "@sanoma-ai/app";
import { type SanomaConfig, startWorker } from "@sanoma-ai/workflows";
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
  const app = await startApp(config, { port, ...appOptions() });
  return { url: app.url, stop: () => app.close() };
}

const GITHUB = ["SANOMA_GITHUB_CLIENT_ID", "SANOMA_GITHUB_CLIENT_SECRET", "SANOMA_GITHUB_REPO"] as const;

/**
 * The app's host (`SANOMA_APP_HOST`, default 127.0.0.1) and, when the `SANOMA_GITHUB_*` variables
 * are set, GitHub sign-in; all three or none. An empty value is the same as unset.
 */
export function appOptions(): Pick<AppOptions, "host" | "login"> {
  const env = process.env;
  const host = env.SANOMA_APP_HOST || undefined;
  const [clientId, clientSecret, repo] = GITHUB.map((name) => env[name]);
  if (!clientId && !clientSecret && !repo) return { host };
  if (!clientId || !clientSecret || !repo) {
    const missing = GITHUB.filter((name) => !env[name]);
    throw new UsageError(`GitHub sign-in needs ${GITHUB.join(", ")}: ${missing.join(", ")} not set`);
  }
  return { host, login: githubLogin({ clientId, clientSecret, repo }) };
}

/** The worker first, then the app, in this process; `stop` stops the app, then the worker. */
export async function serve(config: SanomaConfig, { port }: { port: number }): Promise<Served> {
  const worker = await runWorker(config);
  let app: Served;
  try {
    app = await runApp(config, { port });
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
