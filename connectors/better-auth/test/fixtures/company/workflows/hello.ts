import { defineWorkflow, z } from "sanoma";

export default defineWorkflow({
  name: "hello",
  title: "Say hello",
  trigger: "manual",
  input: z.object({ who: z.string() }),
  uses: [],
  run: async (_ctx, { who }) => ({ greeting: `hello ${who}` }),
});
