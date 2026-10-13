import { startApp } from "@sanoma/app";
import { type SanomaConfig, startWorker } from "@sanoma/workflows";

export interface Stoppable {
  stop(): Promise<void>;
}

export interface Served extends Stoppable {
  /** Where the app listens, such as `http://127.0.0.1:3000`. */
  url: string;
}

export interface Working extends Stoppable {
  /** The vendors whose drivers could not run when the worker started, in the config's order (`Worker.unconfigured`). */
  unconfigured: string[];
}

/** Starts the worker, promoted: a local worker is always the version to take queued runs, even one seen before. */
export async function runWorker(config: SanomaConfig): Promise<Working> {
  const worker = await startWorker(config, { promote: true });
  return { unconfigured: [...worker.unconfigured.keys()], stop: () => worker.stop() };
}

/** Starts the app on `port` (0 for any free port); `url` says where. */
export async function runApp(config: SanomaConfig, { port }: { port: number }): Promise<Served> {
  const app = await startApp(config, { port });
  return { url: app.url, stop: () => app.close() };
}

/** The worker first, then the app, in this process; `stop` stops the app, then the worker. */
export async function serve(config: SanomaConfig, { port }: { port: number }): Promise<Served & Working> {
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
    unconfigured: worker.unconfigured,
    async stop() {
      try {
        await app.stop();
      } finally {
        await worker.stop();
      }
    },
  };
}
