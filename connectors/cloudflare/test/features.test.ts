import { withSetup } from "@sanoma-ai/workflows";
import { describeFeatures } from "@sanoma-ai/testing/features";
import { live } from "@sanoma-ai/testing/replay";
import { cloudflareDriver } from "../src/driver.ts";
import { cloudflare } from "../src/index.ts";
import { replayOptions } from "./replay.ts";

// features/, on the fake and on the replies in fixtures/ (written from Cloudflare's API reference).
// Replayed replies are ready at once, so the driver need not wait its 2 s between looks; live ones are not.
const connector = live ? cloudflare : withSetup(cloudflare, { driver: () => cloudflareDriver({ pollMs: 1 }) });
await describeFeatures(connector, { features: new URL("../features/", import.meta.url), replay: replayOptions });
