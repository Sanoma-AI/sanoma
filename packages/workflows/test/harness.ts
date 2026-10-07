import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { fakeBluesky } from "@sanoma/connector-bluesky/fake";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
import { resend } from "@sanoma/connector-resend";
import { fakeResend } from "@sanoma/connector-resend/fake";
import type { FakeCall } from "@sanoma/workflows/fake";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { allowAll, jsonlLedger, SanomaClient, type SanomaConfig, startWorker, type Worker } from "../src/index.ts";
import announce from "./fixtures/announce.ts";

export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();

/** The fakes the announce workflow calls, logging into one list so the order across vendors shows. */
export function marketingFakes() {
  const calls: FakeCall[] = [];
  const blog = fakeGhost({ calls });
  const email = fakeResend({ calls });
  const social = fakeBluesky({ calls });
  return { calls, ghost: blog, resend: email, bluesky: social, drivers: [blog.driver, email.driver, social.driver] };
}

export type Vendors = ReturnType<typeof marketingFakes>;

const defined = <T>(x: T | undefined, what: string): T => {
  if (x === undefined) throw new Error(`${what} is not started`);
  return x;
};

export interface App {
  readonly vendors: Vendors;
  readonly config: SanomaConfig;
  readonly worker: Worker;
  readonly client: SanomaClient;
  /** Sends messages the way any process with database access could, without SanomaClient's checks. */
  readonly raw: DBOSClient;
  /** Operation ids the fake vendors were called with, in order. */
  ops(): string[];
  /** Stops the worker and starts another on the same config, as a restarted process would. */
  restart(): Promise<void>;
  /** Runs a test leaves unfinished on purpose; cancelled after the describe. */
  readonly leftPending: string[];
}

/**
 * Starts a worker and a client for one `describe`, on its own app name in the file's database,
 * and stops them after it. Fake vendors reset before each test; the ledger is on disk so it
 * outlives a restart the way it would across processes.
 */
export function useApp(
  databaseUrl: string,
  appName: string,
  overrides: (vendors: Vendors) => Partial<SanomaConfig> = () => ({}),
): App {
  const vendors = marketingFakes();
  const ledgerDir = mkdtempSync(join(tmpdir(), `sanoma-ledger-${appName}-`));
  let config: SanomaConfig;
  let worker: Worker | undefined;
  let client: SanomaClient | undefined;
  let raw: DBOSClient | undefined;
  const leftPending: string[] = [];

  beforeAll(async () => {
    config = {
      workflows: [announce],
      connectors: [ghost, resend, bluesky],
      drivers: vendors.drivers,
      policy: allowAll,
      ledger: jsonlLedger(ledgerDir),
      databaseUrl,
      appName,
      ...overrides(vendors),
    };
    worker = await startWorker(config);
    client = await SanomaClient.connect(config);
    raw = await DBOSClient.create({ systemDatabaseUrl: databaseUrl, applicationName: appName });
  });

  afterAll(async () => {
    if (leftPending.length) await raw?.cancelWorkflows(leftPending);
    await client?.close();
    await raw?.destroy();
    await worker?.stop();
    rmSync(ledgerDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vendors.ghost.reset();
    vendors.resend.reset();
    vendors.bluesky.reset();
  });

  return {
    vendors,
    get config() {
      return defined(config, "config");
    },
    get worker() {
      return defined(worker, "worker");
    },
    get client() {
      return defined(client, "client");
    },
    get raw() {
      return defined(raw, "raw client");
    },
    ops: () => vendors.calls.map((c) => c.op),
    async restart() {
      await defined(worker, "worker").stop();
      worker = await startWorker(config);
    },
    leftPending,
  };
}

/** True once the run has `count` approvals and exactly one of them is pending. */
export const pending =
  (client: () => SanomaClient, runId: string, count = 1) =>
  async () => {
    const approvals = await client().approvals(runId);
    return approvals.filter((a) => a.status === "pending").length === 1 && approvals.length === count;
  };
