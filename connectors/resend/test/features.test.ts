import { describeFeatures } from "@sanoma-ai/testing/features";
import { resend } from "../src/index.ts";
import { replayOptions } from "./replay.ts";

// features/, on the fake and on the recorded replies in fixtures/.
await describeFeatures(resend, { features: new URL("../features/", import.meta.url), replay: replayOptions });
