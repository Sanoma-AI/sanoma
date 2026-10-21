import { github } from "@sanoma-ai/connector-github";
import { stripe } from "@sanoma-ai/connector-stripe";
import { defineConfig, memoryLedger } from "../../../src/index.ts";

// A company's config, for the data files beside it in resources/: defineConfig records this
// file, so its directory is the config's root.
export default defineConfig({
  workflows: [],
  connectors: [github, stripe],
  ledger: memoryLedger(),
});
