import { allow, defineConfig, definePolicy, defineWorkflow, z } from "sanoma";

const hello = defineWorkflow({
  name: "hello",
  title: "Say hello",
  trigger: "manual",
  input: z.object({ who: z.string() }),
  uses: [],
  run: async (_ctx, { who }) => ({ greeting: `hello ${who}` }),
});

/** A company with one site, sites/hello. */
export default defineConfig({
  workflows: [hello],
  connectors: [],
  policy: definePolicy(() => allow()),
});
