import { type FixtureError, tfFake, type TfFakeOptions, type TfFakeState } from "@sanoma-ai/bridge/fake";
import { githubTf } from "./connector.ts";
import { owned } from "./owner.ts";

/**
 * What the provider answers an import of an object that is not there: for a branch protection
 * rule, `failed_precondition` with the diagnostic it was recorded with (`provider-bridge:main`);
 * for anything else, nothing found (`not_found`).
 */
function missingReply(type: string, id: string): FixtureError | undefined {
  if (type !== "branch_protection") return undefined;
  const summary = `could not find a branch protection rule with the pattern '${id.slice(id.indexOf(":") + 1)}'`;
  return {
    code: "failed_precondition",
    message: `import github_branch_protection "${id}": ${summary}`,
    diagnostics: [{ severity: "SEVERITY_ERROR", summary }],
  };
}

export type FakeGithubState = TfFakeState;
export type FakeGithubOptions = TfFakeOptions;

/**
 * A GitHub that answers as the provider did when its replies were recorded (`@sanoma-ai/bridge`'s
 * `testdata/replies`), through the real driver over a bridge of those replies: `import` and
 * `read` return the recorded repositories (`Sanoma-AI/sanoma`, `Sanoma-AI/provider-bridge`), and
 * `branch_protection` on `provider-bridge:main` fails as it did (the branch is unprotected).
 * Nothing reaches GitHub, and no token is read. Its calls name owners as the driver's do
 * (`Sanoma-AI/sanoma`); a node id is found among its objects, with no query.
 *
 * `put` makes an object, `override` changes what the next read returns, as if someone edited
 * the object at GitHub, and `remove` deletes it, so the next read says it is gone and an import
 * answers as the provider does.
 */
export function fakeGithub(options: FakeGithubOptions = {}) {
  const fake = tfFake(githubTf, { missingReply, ...options });
  // Named by owner as the driver's calls are; the fake's own objects are held by the provider's
  // import ids (`sanoma`, `sanoma:main`), what `put`, `override` and `remove` take.
  const { driver } = fake;
  return Object.assign(fake, { driver: owned(() => driver) });
}
