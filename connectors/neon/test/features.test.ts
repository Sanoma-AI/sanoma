import { describeFeatures } from "@sanoma-ai/testing/features";
import { neon } from "../src/index.ts";
import { replayOptions } from "./replay.ts";
import { live } from "@sanoma-ai/testing/replay";
import { TEST_KEY } from "./replay.ts";

// features/, on the fake and on the replies in fixtures/.
await describeFeatures(neon, {
  features: new URL("../features/", import.meta.url),
  replay: replayOptions,
  driverContext: () => ({
    authentication: {
      kind: "api-key",
      method: "apiKey",
      credentialVersion: "test",
      credentials: { apiKey: live ? process.env.NEON_API_KEY! : TEST_KEY },
    },
  }),
});
