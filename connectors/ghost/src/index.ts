import { withSetup } from "@sanoma/workflows";
import { ghost as declared } from "./connector.ts";
import { ghostDriver } from "./driver.ts";
import { fakeGhost } from "./fake.ts";

export { Post } from "./connector.ts";

/**
 * Ghost Admin API posts: `post.create` and `post.publish`. It carries its live driver
 * (`ghostDriver`), which reads its credentials when called, and its fake (`fakeGhost`), which
 * sandbox runs and scenarios copy.
 */
export const ghost = withSetup(declared, { driver: () => ghostDriver(), fake: () => fakeGhost() });
