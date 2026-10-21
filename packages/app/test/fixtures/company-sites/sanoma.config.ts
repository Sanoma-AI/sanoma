import { defineConfig, defineWorkflow, z } from "sanoma";
import { leads } from "./resources/data.ts";

const hello = defineWorkflow({
  name: "hello",
  title: "Say hello",
  trigger: "manual",
  input: z.object({ who: z.string() }),
  uses: [],
  run: async (_ctx, { who }) => ({ greeting: `hello ${who}` }),
});

/** A company with one site, sites/hello, and one collection. */
export default defineConfig({
  workflows: [hello],
  connectors: [],
  collections: [leads],
});
