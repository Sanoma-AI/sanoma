import { bluesky } from "@sanoma/connector-bluesky";
import { fakeBluesky } from "@sanoma/connector-bluesky/fake";
import { ghost } from "@sanoma/connector-ghost";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
import { resend } from "@sanoma/connector-resend";
import { fakeResend } from "@sanoma/connector-resend/fake";
import { allowAll, memoryLedger, type SanomaConfig } from "@sanoma/workflows";
import announce from "../../../workflows/test/fixtures/announce.ts";

// scenarios/announce.feature is a copy of the workflows package's: its scenarios directory also
// holds review.feature and sample.feature, for workflows its tests define inline, not this config.

const fakes = [fakeGhost(), fakeResend(), fakeBluesky()];

/** A company's config, as its scenario tests would spread it: sandbox runs call the fakes. */
export const config = {
  workflows: [announce],
  connectors: [ghost, resend, bluesky],
  drivers: fakes.map((fake) => fake.driver),
  fakes,
  policy: allowAll,
  ledger: memoryLedger(),
} satisfies Omit<SanomaConfig, "appName">;
