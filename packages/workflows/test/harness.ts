import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { fakeBluesky } from "@sanoma/connector-bluesky/fake";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
import { resend } from "@sanoma/connector-resend";
import { fakeResend } from "@sanoma/connector-resend/fake";
import { testDatabaseUrl } from "@sanoma/testing";
import { type TestApp, useTestApp } from "@sanoma/testing/harness";
import type { Fake, FakeCall, FakeOptions } from "@sanoma/workflows/fake";
import { afterAll, beforeEach } from "vitest";
import {
  allowAll,
  type Connector,
  jsonlLedger,
  type LedgerRecord,
  type SanomaClient,
  type SanomaConfig,
  withSetup,
} from "../src/index.ts";
import { VENDOR } from "../src/op.ts";
import announce from "./fixtures/announce.ts";

export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();

/** A run's records by type, an operation call's with its operation: what the tests compare the order of. */
export const types = (records: LedgerRecord[]) =>
  records.map((r) => (r.type === "op.called" ? `${r.type} ${r.op}` : r.type));

/** What the promise rejects with; it fails the test by resolving. */
export const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected the run to fail");
    },
    (e: unknown) => e,
  );

/** The connector with nothing attached: no driver, and no fake. */
export const withoutSetup = <C extends Connector<any, any>>(connector: C): C => ({
  ...connector,
  [VENDOR]: { ...connector[VENDOR], setup: {} },
});

/** A fake vendor's maker, such as `fakeGhost`. */
type MakeFake = (options: FakeOptions) => Fake<any, any>;

/** Another vendor a test adds: its connector, and the maker of its fake. */
export type Extra = readonly [Connector<any, any>, MakeFake];

/**
 * The fakes the announce workflow calls, and the `extra` ones a test adds, all logging into one
 * list so the order across vendors shows. `connectors` are their connectors with each fake's
 * driver swapped in (`withSetup`), so live runs call these very fakes, and each keeps the maker of
 * its package's fake, so each sandbox run calls a fake of its own. A test swaps a driver with
 * `withSetup(connector, { driver })` over them.
 */
export function marketingFakes({ extra = [] }: { extra?: readonly Extra[] } = {}) {
  const calls: FakeCall[] = [];
  const blog = fakeGhost({ calls });
  const email = fakeResend({ calls });
  const social = fakeBluesky({ calls });
  const pairs: (readonly [Connector<any, any>, Fake<any, any>])[] = [
    [ghost, blog],
    [resend, email],
    [bluesky, social],
    ...extra.map(([connector, make]) => [connector, make({ calls })] as const),
  ];
  return {
    calls,
    ghost: blog,
    resend: email,
    bluesky: social,
    connectors: pairs.map(([connector, fake]) => withSetup(connector, { driver: () => fake.driver })),
    reset: () => pairs.forEach(([, fake]) => fake.reset()),
  };
}

export type Vendors = ReturnType<typeof marketingFakes>;

export type App = TestApp & {
  readonly vendors: Vendors;
  /** Operation ids the fake vendors were called with, in order. */
  ops(): string[];
};

/**
 * `useTestApp` on the announce workflow and the marketing fakes, which `overrides` may replace,
 * for one `describe`, on a database of its own, `testDatabaseUrl(name)`: tests are kept apart by
 * database, and the app keeps its default name. The fakes, and the `extra` ones, reset before
 * each test; the ledger is on disk so it outlives a restart the way it would across processes.
 */
export function useApp(
  name: string,
  overrides: (vendors: Vendors) => Partial<SanomaConfig> = () => ({}),
  { extra }: { extra?: readonly Extra[] } = {},
): App {
  const vendors = marketingFakes({ extra });
  const ledgerDir = mkdtempSync(join(tmpdir(), `sanoma-ledger-${name}-`));
  // Registered before useTestApp's, so it runs after the worker stops (after hooks run in reverse).
  afterAll(() => rmSync(ledgerDir, { recursive: true, force: true }));
  const app = useTestApp(
    {
      workflows: [announce],
      // Live runs on these fakes; each sandbox run on its own, from the packages' makers.
      connectors: vendors.connectors,
      policy: allowAll,
      ledger: jsonlLedger(ledgerDir),
      ...overrides(vendors),
    },
    { databaseUrl: testDatabaseUrl(name) },
  );
  beforeEach(() => vendors.reset());
  // Object.assign keeps the getters; a spread would read them before beforeAll.
  return Object.assign(app, { vendors, ops: () => vendors.calls.map((c) => c.op) });
}

/** True once the run has `count` approvals and exactly one of them is pending. */
export const pending =
  (client: () => SanomaClient, runId: string, count = 1) =>
  async () => {
    const approvals = await client().approvals(runId);
    return approvals.filter((a) => a.status === "pending").length === 1 && approvals.length === count;
  };
