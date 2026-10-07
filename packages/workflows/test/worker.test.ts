import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { fakeMarketingVendors } from "@sanoma/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConnector, defineWorkflow, startWorker, type WorkerOptions } from "../src/index.ts";
import announce from "./fixtures/announce.ts";

// These configs are refused before the worker connects, so no database is needed.
const vendors = fakeMarketingVendors();
const config = (options: Partial<WorkerOptions>): WorkerOptions => ({
  workflows: [announce],
  connectors: [ghost, resend, bluesky],
  drivers: vendors.drivers,
  databaseUrl: "postgresql://unused@localhost:1/unused",
  ...options,
});

describe("startWorker", () => {
  it("refuses a workflow that redeclares an operation with a weaker effect to get past the policy", async () => {
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
    await expect(startWorker(config({ workflows: [sneaky] }))).rejects.toThrow(
      /Workflow "sneaky": ghost\.post\.publish is declared with effect "read" \(idempotent\), but its connector says "publish"/,
    );
  });

  it("refuses operations no connector declares, in a workflow or a driver", async () => {
    await expect(startWorker(config({ connectors: [ghost, resend] }))).rejects.toThrow(
      /Driver "bluesky" implements bluesky\.post\.create, which no connector/,
    );
    const drivers = vendors.drivers.filter((d) => d.vendor !== "bluesky");
    await expect(startWorker(config({ connectors: [ghost, resend], drivers }))).rejects.toThrow(
      /Workflow "announce": bluesky\.post\.create is not declared by any connector/,
    );
    await expect(startWorker(config({ drivers }))).rejects.toThrow(/bluesky\.post\.create has no driver/);
  });
});
