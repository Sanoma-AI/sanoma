import { bluesky } from "@sanoma-ai/connector-bluesky";
import { fakeBluesky } from "@sanoma-ai/connector-bluesky/fake";
import { resend } from "@sanoma-ai/connector-resend";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { testDatabaseUrl, withFake } from "@sanoma-ai/testing";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  allowAll,
  defineConnector,
  defineWorkflow,
  memoryLedger,
  resolveConfig,
  type SanomaConfig,
  startWorker,
  withSetup,
} from "../src/index.ts";
import { describeConfig } from "../src/describe.ts";
import announce from "./fixtures/announce.ts";
import { noop } from "./fixtures/minimal.ts";
import { marketingFakes, useApp, withoutSetup } from "./harness.ts";

// These configs are refused before the worker connects, so no database is needed.
const vendors = marketingFakes();
const ledger = memoryLedger();
const config = (options: Partial<SanomaConfig>): SanomaConfig => ({
  workflows: [announce],
  connectors: vendors.connectors,
  policy: allowAll,
  ledger,
  databaseUrl: "postgresql://unused@localhost:1/unused",
  ...options,
});
const [onGhost, onResend, onBluesky] = vendors.connectors;

const forged = defineConnector("ghost", {
  post: { publish: { effect: "read", idempotent: true, input: z.any(), output: z.any() } },
});
const sneaky = defineWorkflow({
  name: "sneaky",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [forged.post.publish],
  run: async (ctx, { id }) => ctx.ghost.post.publish({ id }),
});

const refused: [string, Partial<SanomaConfig>, RegExp][] = [
  [
    "a workflow that redeclares an operation with a weaker effect to get past the policy",
    { workflows: [sneaky] },
    /^Workflow "sneaky": ghost\.post\.publish is declared with effect "read" \(idempotent\), but its connector says "publish"/,
  ],
  [
    "a driver for an operation no connector declares",
    { connectors: [onGhost!, withFake(resend, vendors.bluesky)] },
    /^Driver "bluesky" implements bluesky\.post\.create, which no connector/,
  ],
  [
    "a workflow using an operation no connector declares",
    { connectors: [onGhost!, onResend!] },
    /^Workflow "announce": bluesky\.post\.create is not declared by any connector/,
  ],
  [
    "a workflow using an operation whose connector carries no driver",
    { connectors: [onGhost!, onResend!, withoutSetup(bluesky)] },
    /`bluesky\.post\.create` has no driver: the connector package must attach one$/,
  ],
  [
    "two different workflows with one name",
    { workflows: [announce, { ...announce }] },
    /^Two different workflow definitions are named "announce"/,
  ],
  ["no policy", { policy: undefined as never }, /^The config needs a `policy`; use `allowAll`/],
  [
    "a ledger that is not a store",
    { ledger: { read: 1 } as never },
    /^The config's `ledger` must be a ledger store: leave it out for `postgresLedger`/,
  ],
  ["no connectors", { connectors: undefined as never }, /^The config needs `connectors`/],
  [
    "two fakes for one vendor",
    { connectors: [...vendors.connectors, withSetup(onBluesky!, { fake: () => fakeBluesky() })] },
    /^Two connectors in `connectors` attach a fake for "bluesky"; keep one per vendor$/,
  ],
  [
    "`drivers` or `fakes`, which an untyped config might still name (fake drivers it would otherwise run live)",
    { drivers: [] } as never,
    /^The config's `drivers` and `fakes` are gone: each connector carries its driver and its fake; leave them out$/,
  ],
  ["`fakes`, alone", { fakes: [] } as never, /^The config's `drivers` and `fakes` are gone/],
];

describe("startWorker, resolveConfig and describeConfig", () => {
  it.each(refused)("refuse %s, with the same message", async (_, options, message) => {
    const bad = config(options);
    let thrown: unknown;
    try {
      resolveConfig(bad);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error | undefined)?.message).toMatch(message);
    const same = (thrown as Error).message;
    expect(() => describeConfig(bad)).toThrow(same);
    await expect(startWorker(bad)).rejects.toThrow(same);
  });

  it("derive the queue, version, policy version and ledger from the config", () => {
    // Neither a root nor a file: no package.json names the app.
    const resolved = resolveConfig(config({}));
    expect(resolved).toMatchObject({
      appName: "sanoma",
      databaseUrl: "postgresql://unused@localhost:1/unused",
      version: expect.stringMatching(/^sanoma@[0-9a-f]{64}$/),
      queueName: "sanoma:sanoma",
      policy: allowAll,
      workflows: new Map([["announce", announce]]),
    });
    expect([...resolved.ops.keys()].toSorted()).toEqual([
      "bluesky.post.create",
      "ghost.post.create",
      "ghost.post.publish",
      "resend.broadcast.create",
      "resend.broadcast.send",
    ]);
    expect([...resolved.drivers.keys()].toSorted()).toEqual([...resolved.ops.keys()].toSorted());
    expect(resolved.ledger).toBe(ledger);
  });
});

describe("startWorker failing after DBOS has launched", () => {
  it("stops DBOS and throws, so nothing runs in a worker nobody holds and the next start launches afresh", async () => {
    const ok = config({ databaseUrl: testDatabaseUrl("worker") });
    vi.spyOn(DBOS, "registerQueue").mockRejectedValueOnce(new Error("no queue for you"));
    await expect(startWorker(ok)).rejects.toThrow("no queue for you");
    expect(DBOS.isInitialized()).toBe(false);
    const worker = await startWorker(ok);
    expect(DBOS.isInitialized()).toBe(true);
    await worker.stop();
  });
});

describe("a worker whose config has no workflow of a name registered earlier in the process", () => {
  const app = useApp("worker-by-name", () => ({ workflows: [announce, noop] }));

  it("refuses its runs, rather than running the earlier worker's definition", async () => {
    await app.stop();
    // Promoted: its version has been seen before, so runs queued without one would otherwise wait for the stopped worker's.
    const without = await startWorker({ ...app.config, workflows: [announce] }, { promote: true });
    try {
      const runId = await app.client.start(noop, {}, { startedBy: { id: "alice" } });
      await expect(app.client.result(runId)).rejects.toThrow(
        /Run of "noop" refused: this worker's config has no workflow of that name/,
      );
    } finally {
      await without.stop();
    }
  });
});
