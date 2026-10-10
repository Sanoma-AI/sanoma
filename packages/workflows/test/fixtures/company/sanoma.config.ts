import { github } from "@sanoma/connector-github";
import { stripe } from "@sanoma/connector-stripe";
import { allowAll, defineConfig, memoryLedger } from "../../../src/index.ts";

// A company's config, for the data files beside it in resources/: defineConfig records this
// file, so its directory is the config's root.
export default defineConfig({
  workflows: [],
  connectors: [github, stripe],
  drivers: [],
  policy: allowAll,
  ledger: memoryLedger(),
});
