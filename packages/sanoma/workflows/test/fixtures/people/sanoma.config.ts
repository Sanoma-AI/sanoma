import { withFake } from "@sanoma-ai/testing";
import { defineConfig, memoryLedger } from "../../../src/index.ts";
import { shop, shopFake } from "./shop.ts";
import refund from "./workflows/refund.ts";

// A company whose people are declared in resources/people.ts and whose policy is
// policies/refunds.cedar, with its scenarios: defineConfig records this file, so its directory is
// the config's root. Its policy is made from the Cedar files as the launcher makes it.
export default defineConfig({
  workflows: [refund],
  connectors: [withFake(shop, shopFake)],
  ledger: memoryLedger(),
});
