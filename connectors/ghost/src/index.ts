import { withSetup } from "@sanoma/workflows";
import { ghostOps } from "./connector.ts";
import { ghostDriver } from "./driver.ts";
import { fakeGhost } from "./fake.ts";

export { Post } from "./connector.ts";

/**
 * Ghost Admin API posts: `post.create` and `post.publish`. It carries its live driver
 * (`ghostDriver`), which reads its credentials when called, and its fake (`fakeGhost`), of which
 * each sandbox run makes its own.
 */
export const ghost = withSetup(ghostOps, { driver: ghostDriver, fake: fakeGhost });
