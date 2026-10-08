import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  allowAll,
  defineConnector,
  defineWorkflow,
  describeConfig,
  resolveConfig,
  type SanomaConfig,
  startWorker,
} from "../src/index.ts";
import announce from "./fixtures/announce.ts";
import { marketingFakes } from "./harness.ts";

// These configs are refused before the worker connects, so no database is needed.
const vendors = marketingFakes();
const config = (options: Partial<SanomaConfig>): SanomaConfig => ({
  workflows: [announce],
  connectors: [ghost, resend, bluesky],
  drivers: vendors.drivers,
  policy: allowAll,
  databaseUrl: "postgresql://unused@localhost:1/unused",
  ...options,
});

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
const withoutBluesky = vendors.drivers.filter((d) => d.vendor !== "bluesky");

const refused: [string, Partial<SanomaConfig>, RegExp][] = [
  [
    "a workflow that redeclares an operation with a weaker effect to get past the policy",
    { workflows: [sneaky] },
    /^Workflow "sneaky": ghost\.post\.publish is declared with effect "read" \(idempotent\), but its connector says "publish"/,
  ],
  [
    "a driver for an operation no connector declares",
    { connectors: [ghost, resend] },
    /^Driver "bluesky" implements bluesky\.post\.create, which no connector/,
  ],
  [
    "a workflow using an operation no connector declares",
    { connectors: [ghost, resend], drivers: withoutBluesky },
    /^Workflow "announce": bluesky\.post\.create is not declared by any connector/,
  ],
  ["a workflow using an operation with no driver", { drivers: withoutBluesky }, /bluesky\.post\.create has no driver$/],
  [
    "two different workflows with one name",
    { workflows: [announce, { ...announce }] },
    /^Two different workflow definitions are named "announce"/,
  ],
  ["no policy", { policy: undefined as never }, /^The config needs a `policy`; use `allowAll`/],
  ["no connectors", { connectors: undefined as never }, /^The config needs `connectors`/],
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
    const resolved = resolveConfig(config({ appName: "acme" }));
    expect(resolved).toMatchObject({
      appName: "acme",
      databaseUrl: "postgresql://unused@localhost:1/unused",
      version: expect.stringMatching(/^acme@[0-9a-f]{64}$/),
      queueName: "sanoma:acme",
      policy: allowAll,
      workflows: [announce],
    });
    expect([...resolved.ops.keys()].toSorted()).toEqual([
      "bluesky.post.create",
      "ghost.post.create",
      "ghost.post.publish",
      "resend.broadcast.create",
      "resend.broadcast.send",
    ]);
    expect([...resolved.drivers.keys()].toSorted()).toEqual([...resolved.ops.keys()].toSorted());
    expect(resolved).not.toHaveProperty("ledger");
    expect(resolveConfig(config({})).appName).toBe("sanoma");
    expect(resolveConfig(config({})).queueName).toBe("sanoma:sanoma");
  });
});
