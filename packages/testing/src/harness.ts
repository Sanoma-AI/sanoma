import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { memoryLedger, SanomaClient, type SanomaConfig, type Worker } from "@sanoma/workflows";
import { afterAll, beforeAll } from "vitest";
import { startTestWorker, testDatabaseUrl, type TestWorkerOptions } from "./index.ts";

/** A test worker and its clients, for the tests of one `describe` (or file). */
export interface TestApp {
  /** The config the worker and the clients share, with its `ledger` and `databaseUrl` resolved. */
  readonly config: SanomaConfig;
  readonly client: SanomaClient;
  /** A DBOS client of the same app, which sends messages and reads steps without SanomaClient's checks. */
  readonly raw: DBOSClient;
  /** Stops the worker, as a process that stopped would; `restart` starts another. */
  stop(): Promise<void>;
  /** Stops the worker (unless `stop` did) and starts another on the same config and ledger, as a restarted process would. */
  restart(): Promise<void>;
}

const started = <T>(x: T | undefined, what: string): T => {
  if (x === undefined) throw new Error(`${what} is not started`);
  return x;
};

/**
 * Starts a test worker, a `SanomaClient` and a raw `DBOSClient` in `beforeAll`, and stops them
 * in `afterAll`. `config` and `options` are `startTestWorker`'s, resolved once (the ledger,
 * default `memoryLedger()`, and the database) so the clients read the worker's runs and a
 * restarted worker keeps its ledger.
 */
export function useTestApp(config: Parameters<typeof startTestWorker>[0], options: TestWorkerOptions = {}): TestApp {
  const shared = {
    ...config,
    ledger: config.ledger ?? memoryLedger(),
    databaseUrl: options.databaseUrl ?? testDatabaseUrl(config.appName),
  };
  let worker: Worker | undefined;
  let client: SanomaClient | undefined;
  let raw: DBOSClient | undefined;

  beforeAll(async () => {
    worker = await startTestWorker(shared, options);
    client = await SanomaClient.connect(shared);
    raw = await DBOSClient.create({ systemDatabaseUrl: shared.databaseUrl, applicationName: shared.appName });
  }, 60_000);

  afterAll(async () => {
    try {
      await client?.close();
      await raw?.destroy();
    } finally {
      await worker?.stop();
    }
  });

  return {
    config: shared,
    get client() {
      return started(client, "client");
    },
    get raw() {
      return started(raw, "raw client");
    },
    async stop() {
      await started(worker, "worker").stop();
      worker = undefined;
    },
    async restart() {
      await worker?.stop();
      worker = await startTestWorker(shared, options);
    },
  };
}
