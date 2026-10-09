import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import base from "../../../../vitest.config.ts";

/** The repo's config, running only the `*.scenarios.ts` files here, which scenarios.test.ts runs. */
export default defineConfig({
  ...base,
  root: fileURLToPath(new URL("../../../../", import.meta.url)),
  test: { ...base.test, include: ["packages/testing/test/fixtures/*.scenarios.ts"] },
});
