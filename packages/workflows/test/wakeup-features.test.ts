import { describeFeatures } from "@sanoma-ai/testing/features";
import { sanomaWakeup } from "../src/config.ts";
import { replayOptions } from "./wakeup-replay.ts";

// test/features/wakeup.feature, `sanoma.wakeup`'s own, on the fake and on the recorded replies in test/fixtures/wakeup.
await describeFeatures(sanomaWakeup, { features: new URL("./features/", import.meta.url), replay: replayOptions });
