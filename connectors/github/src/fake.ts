import { tfFake, type TfFakeOptions, type TfFakeState } from "@sanoma/bridge/fake";
import { githubTf } from "./connector.ts";

export type FakeGithubState = TfFakeState;
export type FakeGithubOptions = TfFakeOptions;

/**
 * A GitHub that answers as the provider did when its replies were recorded (`@sanoma/bridge`'s
 * `testdata/replies`), through the real driver over a bridge of those replies: `import` and
 * `read` return the recorded repositories (`Sanoma-AI/sanoma`, `Sanoma-AI/provider-bridge`), and
 * `branch_protection` on `provider-bridge:main` fails as it did (the branch is unprotected).
 * Nothing reaches GitHub, and no token is read.
 *
 * `override` changes what the next read returns, as if someone edited the object at GitHub,
 * and `remove` deletes it, so the next read says it is gone.
 */
export const fakeGithub = (options: FakeGithubOptions = {}) => tfFake(githubTf, options);
