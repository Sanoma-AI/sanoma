import { fakeBluesky } from "@sanoma/connector-bluesky/fake";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
import { fakeResend } from "@sanoma/connector-resend/fake";
import { type FakeCall, memoryLedger, startWorker } from "@sanoma/workflows";

export { fakeBluesky, type FakeBlueskyPost, type FakeBlueskyState } from "@sanoma/connector-bluesky/fake";
export { fakeGhost, type FakeGhostPost, type FakeGhostState } from "@sanoma/connector-ghost/fake";
export { fakeResend, type FakeResendBroadcast, type FakeResendState } from "@sanoma/connector-resend/fake";
export type { Fake, FakeCall, FakeOptions } from "@sanoma/workflows";

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

/**
 * Fake Ghost, Resend and Bluesky behind one object, logging into one call list. Pass `file`
 * to keep their state on disk, one file per vendor beside it (`x.json` becomes
 * `x.ghost.json`, `x.resend.json` and `x.bluesky.json`).
 *
 * @deprecated Use `fakeGhost`, `fakeResend` and `fakeBluesky` (from here or from
 * `@sanoma/connector-<vendor>/fake`), passing them one `calls` array to keep a shared log.
 */
export function fakeMarketingVendors(options: { file?: string } = {}) {
  const calls: FakeCall[] = [];
  const file = (vendor: string) => options.file?.replace(/(\.json)?$/, `.${vendor}.json`);
  const ghost = fakeGhost({ file: file("ghost"), calls });
  const resend = fakeResend({ file: file("resend"), calls });
  const bluesky = fakeBluesky({ file: file("bluesky"), calls });
  return {
    drivers: [ghost.driver, resend.driver, bluesky.driver],
    /** The current state, re-read from disk when a file is used. */
    get state() {
      return {
        calls,
        posts: ghost.state.posts,
        broadcasts: resend.state.broadcasts,
        social: bluesky.state.posts,
      };
    },
    /** The ids of the operations called so far, in order. */
    ops: () => calls.map((c) => c.op),
    reset() {
      ghost.reset();
      resend.reset();
      bluesky.reset();
    },
  };
}
