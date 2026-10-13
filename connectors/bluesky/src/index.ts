import { withSetup } from "@sanoma/workflows";
import { blueskyOps } from "./connector.ts";
import { blueskyDriver } from "./driver.ts";
import { fakeBluesky } from "./fake.ts";

/**
 * Bluesky posts: `post.create`. It carries its live driver (`blueskyDriver`), which reads its
 * credentials when called, and its fake (`fakeBluesky`), which sandbox runs and scenarios copy.
 */
export const bluesky = withSetup(blueskyOps, { driver: blueskyDriver, fake: fakeBluesky });
