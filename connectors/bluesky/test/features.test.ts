import { describeFeatures } from "@sanoma/testing/features";
import { bluesky } from "../src/index.ts";
import { replayOptions } from "./replay.ts";

// features/, on the fake and on the recorded replies in fixtures/.
describeFeatures(bluesky, { features: new URL("../features/", import.meta.url), replay: replayOptions });
