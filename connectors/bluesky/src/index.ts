import { withSetup } from "@sanoma/workflows";
import { blueskyOps } from "./connector.ts";
import { blueskyDriver } from "./driver.ts";
import { fakeBluesky } from "./fake.ts";
import { blueskySteps } from "./steps.ts";

/**
 * Bluesky posts: `post.create`. It carries its live driver (`blueskyDriver`), which reads its
 * credentials when called, its fake (`fakeBluesky`), of which each sandbox run makes its own,
 * and its steps for Gherkin tests (`blueskySteps`).
 */
export const bluesky = withSetup(blueskyOps, { driver: blueskyDriver, fake: fakeBluesky, steps: blueskySteps });
