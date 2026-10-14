import { describeFeatures } from "@sanoma/testing/features";
import { ghost } from "../src/index.ts";
import { replayOptions } from "./replay.ts";

// features/, on the fake and on the recorded replies in fixtures/.
await describeFeatures(ghost, { features: new URL("../features/", import.meta.url), replay: replayOptions });
