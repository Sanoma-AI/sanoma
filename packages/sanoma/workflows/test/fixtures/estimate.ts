import { z } from "zod";
import { defineOperation } from "../../src/index.ts";

/** A company operation in a file of its own that calls nothing: a change to this file is a change to each workflow that uses it. */
export default defineOperation({
  name: "estimate",
  input: z.object({}),
  uses: [],
  run: async () => 1,
});
