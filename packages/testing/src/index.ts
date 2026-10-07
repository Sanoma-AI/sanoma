import { memoryLedger, startWorker } from "@sanoma/workflows";

export { fakeBluesky, type FakeBlueskyPost, type FakeBlueskyState } from "@sanoma/connector-bluesky/fake";
export { fakeGhost, type FakeGhostPost, type FakeGhostState } from "@sanoma/connector-ghost/fake";
export { fakeResend, type FakeResendBroadcast, type FakeResendState } from "@sanoma/connector-resend/fake";
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

type WorkerConfig = Parameters<typeof startWorker>[0];
type Filled = "appName" | "databaseUrl" | "ledger";

/**
 * Starts a worker for a test. `appName` defaults to "sanoma-test", `databaseUrl` to
 * `testDatabaseUrl(appName)`, and `ledger` to a fresh in-memory ledger; everything else is
 * passed to `startWorker` as given. Stop the worker in `afterAll`.
 */
export function startTestWorker(
  config: Omit<WorkerConfig, Filled> & Partial<Pick<WorkerConfig, Filled>>,
): ReturnType<typeof startWorker> {
  const appName = config.appName ?? "sanoma-test";
  return startWorker({
    ...config,
    appName,
    databaseUrl: config.databaseUrl ?? testDatabaseUrl(appName),
    ledger: config.ledger ?? memoryLedger(),
  });
}
