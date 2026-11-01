import { withSetup } from "@sanoma-ai/workflows";
import { githubOps } from "./connector.ts";
import { githubDriver } from "./driver.ts";
import { fakeGithub } from "./fake.ts";
import { githubRemote } from "./remote.ts";

/**
 * GitHub resources, read through the `integrations/github` OpenTofu provider: each type has a
 * `read` and an `import` operation (`github.repository.read`), both effect `read`; and the
 * operations through Sanoma's GitHub App (`github.installation.get`, `github.repository.generate`,
 * `.commit`, `.addDeployKey`), each on an installation token minted when called. It carries its
 * live driver (`githubDriver`, on the default bridge), its fake (`fakeGithub`), of which each
 * sandbox run makes its own, and its remote half (`githubRemote`): a repository's pull requests,
 * the `sanoma` status, the rules on a branch and the App's webhooks.
 */
export const github = withSetup(githubOps, {
  driver: githubDriver,
  fake: fakeGithub,
  remote: () => githubRemote,
});
