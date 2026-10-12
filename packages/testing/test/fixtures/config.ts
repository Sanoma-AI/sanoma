import { fileURLToPath } from "node:url";
import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { allowAll, memoryLedger, type SanomaConfig } from "@sanoma/workflows";
import announce from "../../../workflows/test/fixtures/announce.ts";

// scenarios/announce.feature is a copy of the workflows package's: its scenarios directory also
// holds review.feature and sample.feature, for workflows its tests define inline, not this config.

/**
 * A company's config, as its scenario tests would spread it: the connectors as their packages
 * export them, whose fakes sandbox runs call, and this directory as its root (its package.json
 * names the app, and its scenarios/ holds the scenarios).
 */
export const config = {
  workflows: [announce],
  connectors: [ghost, resend, bluesky],
  policy: allowAll,
  ledger: memoryLedger(),
  root: fileURLToPath(new URL(".", import.meta.url)),
} satisfies SanomaConfig;
