import { createHash } from "node:crypto";
import { defineConnector, defineDriver, defineWorkflow, withSetup } from "@sanoma-ai/workflows";
import { z } from "sanoma";

// A copy of `@sanoma-ai/testing/host`'s `hostCheck` and `hostCheckWorkflows`: same names, ops and digest.

const CREDENTIAL = "HOST_CHECK_TOKEN";
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

const ops = defineConnector("hostcheck", {
  probe: {
    digest: {
      effect: "read",
      idempotent: true,
      description: `A digest of ${CREDENTIAL} as the worker holds it, never the value`,
      input: z.object({}),
      output: z.object({ digest: z.string() }),
    },
  },
});
const driver = defineDriver(
  ops,
  { probe: { digest: async () => ({ digest: digest(process.env[CREDENTIAL] ?? "") }) } },
  { env: z.object({ [CREDENTIAL]: z.string().describe("Any value: the host check sets it") }) },
);

export const hostCheck = withSetup(ops, { driver: () => driver });

export const hostCheckWorkflows = [
  defineWorkflow({
    name: "host-check-drain",
    trigger: "manual",
    input: z.object({}),
    uses: [],
    run: async () => ({ drained: true }),
  }),
  defineWorkflow({
    name: "host-check-sleep",
    trigger: "manual",
    input: z.object({ seconds: z.number() }),
    uses: ["sleep"],
    run: async (ctx, { seconds }) => {
      await ctx.sleep({ seconds });
      return { slept: seconds };
    },
  }),
  defineWorkflow({
    name: "host-check-credential",
    trigger: "manual",
    input: z.object({}),
    uses: [hostCheck.probe.digest],
    run: async (ctx) => ctx.hostcheck.probe.digest({}),
  }),
] as const;
