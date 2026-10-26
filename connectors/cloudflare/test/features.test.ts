import { describeFeatures } from "@sanoma-ai/testing/features";
import { cloudflare } from "../src/index.ts";
import { replayOptions } from "./replay.ts";

// features/, on the fake and on the replies in fixtures/ (written from Cloudflare's API reference).
await describeFeatures(cloudflare, { features: new URL("../features/", import.meta.url), replay: replayOptions });
