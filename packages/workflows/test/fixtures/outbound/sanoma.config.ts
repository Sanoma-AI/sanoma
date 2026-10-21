import { allowAll, defineConfig, memoryLedger } from "../../../src/index.ts";
import { outbound } from "./resources/data.ts";
import outboundNext from "./workflows/outbound-next.ts";

// A company with one collection, the workflow that moves its leads on, and its scenarios:
// defineConfig records this file, so its directory is the config's root.
export default defineConfig({
  workflows: [outboundNext],
  connectors: [],
  policy: allowAll,
  collections: [outbound],
  ledger: memoryLedger(),
});
