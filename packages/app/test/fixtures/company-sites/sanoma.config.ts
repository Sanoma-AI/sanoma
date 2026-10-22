import { defineConfig, defineWorkflow, z } from "sanoma";
import { fixtureLogin } from "./login.ts";
import { leads } from "./resources/data.ts";

const hello = defineWorkflow({
  name: "hello",
  title: "Say hello",
  trigger: "manual",
  input: z.object({ who: z.string() }),
  uses: [],
  run: async (_ctx, { who }) => ({ greeting: `hello ${who}` }),
});

/** A company with two public sites, sites/hello and sites/members (behind fixture-login), and one collection. */
export default defineConfig({
  workflows: [hello],
  connectors: [fixtureLogin],
  collections: [leads],
});
