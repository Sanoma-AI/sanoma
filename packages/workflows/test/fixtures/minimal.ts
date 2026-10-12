import { z } from "zod";
import { allowAll, defineConnector, defineWorkflow, type SanomaConfig } from "../../src/index.ts";

/** A workflow that calls nothing and returns 1. */
export const noop = defineWorkflow({
  name: "noop",
  trigger: "manual",
  input: z.object({}),
  uses: [],
  run: async () => 1,
});

/** The smallest config a worker starts on: `noop`, a connector with no operations, no drivers, every call allowed. */
export const minimal = (databaseUrl: string): SanomaConfig => ({
  workflows: [noop],
  connectors: [defineConnector("none", {})],
  drivers: [],
  policy: allowAll,
  databaseUrl,
});
