import { describeFeatures } from "@sanoma-ai/testing/features";
import { exa } from "../src/index.ts";
import { replayOptions } from "./replay.ts";

// features/, on the fake and on the replies in fixtures/.
await describeFeatures(exa, { features: new URL("../features/", import.meta.url), replay: replayOptions });
