import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Connector,
  type Driver,
  memoryLedger,
  resolveConfig,
  type SanomaConfig,
  startWorker,
  type Worker,
  type WorkerOptions,
  withSetup,
} from "@sanoma/workflows";
import type { Fake } from "@sanoma/workflows/fake";

export type { Fake, FakeCall, FakeOptions } from "@sanoma/workflows/fake";
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

/**
 * A directory whose `package.json` names the app `name`, for a test config's `root`: the app's
 * name scopes its runs, queues and versions in the database, and names its test database
 * (`startTestWorker`). It holds nothing else, so the config has no scenarios and no data files.
 * The same name gives the same directory, made when missing.
 */
export function testRoot(name: string): string {
  const dir = join(tmpdir(), "sanoma-test-roots", name.replace(/[^a-z0-9_.-]/gi, "_"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name, private: true, type: "module" })}\n`);
  return dir;
}

/**
 * `connector` set up with this fake instead of the one its package attaches, for a test that
 * seeds or reads the fake its runs call: `fake` is what live runs call (through `driver`, by
 * default the fake's own) and the template sandbox runs copy. The operations are the same.
 */
export function withFake<C extends Connector<any, any>>(
  connector: C,
  fake: Fake<any, any>,
  driver: Driver = fake.driver,
): C {
  return withSetup(connector, { driver: () => driver, fake: () => fake });
}

/** `startWorker`'s options, and the database to use instead of the test's own. */
export interface TestWorkerOptions extends WorkerOptions {
  /** Defaults to `testDatabaseUrl(<the config's app name>)`. */
  databaseUrl?: string;
}

/**
 * Starts a worker for a test. The worker runs on `options.databaseUrl`, else
 * `testDatabaseUrl(<app name>)`, the app name being its `root`'s `package.json`'s (give a test
 * file its own with `testRoot`), never on a `databaseUrl` the config carries: a test that spreads
 * the project's config must not reach its real database. `ledger` defaults to a fresh in-memory
 * ledger. Everything else in `config`, and `options` (`promote`, `logLevel`), go to `startWorker`
 * as given. Stop the worker in `afterAll`.
 */
export function startTestWorker(config: SanomaConfig, options: TestWorkerOptions = {}): Promise<Worker> {
  const { databaseUrl, ...workerOptions } = options;
  return startWorker(
    {
      ...config,
      databaseUrl: databaseUrl ?? testDatabaseUrlOf(config),
      ledger: config.ledger ?? memoryLedger(),
    },
    workerOptions,
  );
}

/** `testDatabaseUrl` of the config's app name. */
export const testDatabaseUrlOf = (config: SanomaConfig): string => testDatabaseUrl(resolveConfig(config).appName);
