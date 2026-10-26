import { describeFeatures } from "@sanoma-ai/testing/features";
import { sanomaOps } from "../src/index.ts";
import { replayOptions } from "./replay.ts";

// features/, on the fake and on the recorded replies in fixtures/.
await describeFeatures(sanomaOps, { features: new URL("../features/", import.meta.url), replay: replayOptions });
