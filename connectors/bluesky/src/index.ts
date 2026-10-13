import { withSetup } from "@sanoma/workflows";
import { blueskyOps } from "./connector.ts";
import { blueskyDriver } from "./driver.ts";
import { fakeBluesky } from "./fake.ts";

/**
 * Bluesky posts: `post.create`. It carries its live driver (`blueskyDriver`), which reads its
 * credentials when called, and its fake (`fakeBluesky`), of which each sandbox run makes its own.
 */
export const bluesky = withSetup(blueskyOps, { driver: blueskyDriver, fake: fakeBluesky });
