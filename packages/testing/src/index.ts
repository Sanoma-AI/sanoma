import { memoryLedger, type SanomaConfig, startWorker, type Worker, type WorkerOptions } from "@sanoma/workflows";

export type { Fake, FakeCall, FakeOptions } from "@sanoma/workflows/fake";

/**
 * The Postgres URL for one test file: `SANOMA_TEST_DATABASE_URL` (default
 * `postgresql://postgres:dbos@localhost:5433/sanoma_test`) with `_<suffix>` appended to the
 * database name. One database per file keeps files from recovering each other's runs. DBOS
 * creates the database if it is missing.
 */
export function testDatabaseUrl(suffix: string): string {
  const base = process.env.SANOMA_TEST_DATABASE_URL ?? "postgresql://postgres:dbos@localhost:5433/sanoma_test";
  const url = new URL(base);
  url.pathname = `${url.pathname}_${suffix.replace(/[^a-z0-9_]/gi, "_")}`;
  return url.toString();
}

/** `startWorker`'s options, and the database to use instead of the test file's own. */
export interface TestWorkerOptions extends WorkerOptions {
  /** Defaults to `testDatabaseUrl(appName)`. */
  databaseUrl?: string;
}

/**
 * Starts a worker for a test. `appName` is required and names the file's database. The worker
 * runs on `options.databaseUrl`, else `testDatabaseUrl(appName)`, never on a `databaseUrl` the
 * config carries: a test that spreads the project's config must not reach its real database.
 * `ledger` defaults to a fresh in-memory ledger. Everything else in `config`, and `options`
 * (`promote`, `logLevel`), go to `startWorker` as given. Stop the worker in `afterAll`.
 */
export function startTestWorker(
  config: Omit<SanomaConfig, "ledger" | "appName"> & { ledger?: SanomaConfig["ledger"]; appName: string },
  options: TestWorkerOptions = {},
): Promise<Worker> {
  const { databaseUrl, ...workerOptions } = options;
  return startWorker(
    {
      ...config,
      databaseUrl: databaseUrl ?? testDatabaseUrl(config.appName),
      ledger: config.ledger ?? memoryLedger(),
    },
    workerOptions,
  );
}
