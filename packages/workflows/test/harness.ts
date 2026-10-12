import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { fakeBluesky } from "@sanoma/connector-bluesky/fake";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
import { resend } from "@sanoma/connector-resend";
import { fakeResend } from "@sanoma/connector-resend/fake";
import { type TestApp, useTestApp } from "@sanoma/testing/harness";
import type { Fake, FakeCall, FakeOptions } from "@sanoma/workflows/fake";
import { beforeEach } from "vitest";
import { allowAll, type LedgerRecord, type SanomaClient, type SanomaConfig } from "../src/index.ts";
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

/** A fake vendor's maker, such as `fakeGhost`. */
type MakeFake = (options: FakeOptions) => Fake<any, any>;

/**
 * The fakes the announce workflow calls, and the `extra` ones a test adds, all logging into one
 * list so the order across vendors shows.
 */
export function marketingFakes({ extra = [] }: { extra?: MakeFake[] } = {}) {
  const calls: FakeCall[] = [];
  const blog = fakeGhost({ calls });
  const email = fakeResend({ calls });
  const social = fakeBluesky({ calls });
  const fakes = [blog, email, social, ...extra.map((make) => make({ calls }))];
  return {
    calls,
    ghost: blog,
    resend: email,
    bluesky: social,
    drivers: fakes.map((fake) => fake.driver),
    reset: () => fakes.forEach((fake) => fake.reset()),
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
 * for one `describe`, on its own app name in the file's database. The fakes, and the `extra`
 * ones, reset before each test.
 */
export function useApp(
  databaseUrl: string,
  appName: string,
  overrides: (vendors: Vendors) => Partial<SanomaConfig> = () => ({}),
  { extra }: { extra?: MakeFake[] } = {},
): App {
  const vendors = marketingFakes({ extra });
  const app = useTestApp(
    {
      workflows: [announce],
      connectors: [ghost, resend, bluesky],
      drivers: vendors.drivers,
      // The same fakes, which each sandbox run copies.
      fakes: [vendors.ghost, vendors.resend, vendors.bluesky],
      policy: allowAll,
      appName,
      ...overrides(vendors),
    },
    { databaseUrl },
  );
  beforeEach(() => vendors.reset());
  return Object.assign(app, { vendors, ops: () => vendors.calls.map((c) => c.op) });
}

/** True once the run has `count` approvals and exactly one of them is pending. */
export const pending =
  (client: () => SanomaClient, runId: string, count = 1) =>
  async () => {
    const approvals = await client().approvals(runId);
    return approvals.filter((a) => a.status === "pending").length === 1 && approvals.length === count;
  };
