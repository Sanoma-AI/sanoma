import { withSetup } from "@sanoma/workflows";
import { githubTf } from "./connector.ts";
import { githubDriver } from "./driver.ts";
import { fakeGithub } from "./fake.ts";

/**
 * GitHub resources, read through the `integrations/github` OpenTofu provider: each type has a
 * `read` and an `import` operation (`github.repository.read`), both effect `read`. It carries its
 * live driver (`githubDriver`, on the default bridge) and its fake (`fakeGithub`), which sandbox
 * runs and scenarios copy.
 */
export const github = withSetup(githubTf.connector, { driver: githubDriver, fake: fakeGithub });
