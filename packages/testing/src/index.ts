import { memoryLedger, type SanomaConfig, startWorker, type Worker, type WorkerOptions } from "@sanoma-ai/workflows";

export { type Fake, type FakeCall, type FakeOptions, withFake } from "@sanoma-ai/workflows/fake";
export { ensureBuilt, waitFor } from "./build.ts";

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

/** `startWorker`'s options, and the database the test runs on. */
export interface TestWorkerOptions extends WorkerOptions {
  /** The test's own database, such as `testDatabaseUrl("announce")`: one per test file, or per `describe` that starts a worker. */
  databaseUrl: string;
}

/**
 * Starts a worker for a test, on `options.databaseUrl`, never on a `databaseUrl` the config
 * carries: a test that spreads the project's config must not reach its real database. Tests are
 * kept apart by database, not by app name, so the app keeps its name (its root's
 * `package.json`'s). `ledger` defaults to a fresh in-memory ledger. Everything else in `config`,
 * and the other options (`promote`, `logLevel`), go to `startWorker` as given. Stop the worker
 * in `afterAll`.
 */
export function startTestWorker(config: SanomaConfig, { databaseUrl, ...options }: TestWorkerOptions): Promise<Worker> {
  return startWorker(testWorkerConfig(config, databaseUrl), options);
}

/** A test worker's config, as `startTestWorker` gives it: on `databaseUrl`, `ledger` a fresh in-memory one by default. */
export function testWorkerConfig(config: SanomaConfig, databaseUrl: string): SanomaConfig {
  return { ...config, databaseUrl, ledger: config.ledger ?? memoryLedger() };
}
