import { defineSteps } from "sanoma/workflows";

/** GitHub's account type for each word a step uses. */
const ACCOUNTS: Record<string, string> = { user: "User", organization: "Organization" };
const SELECTIONS = ["all", "selected"];

/**
 * GitHub's steps for Gherkin tests: an installation of the App before the run, as a person makes
 * one on GitHub's pages, on a personal account or an organization (`login`, whose account id is
 * the installation's), covering all its repositories or only those selected.
 */
export const githubSteps = defineSteps("github", ({ given }) => {
  given(
    "a GitHub App installation {int} on the {word} {string} with {word} repositories",
    (id: number, account: string, login: string, selection: string) => {
      const type = ACCOUNTS[account];
      if (!type) throw new Error(`an installation is on a user or an organization, not a ${account}`);
      if (!SELECTIONS.includes(selection))
        throw new Error(`an installation has all or selected repositories, not ${selection}`);
      return {
        resource: "github.installation",
        name: String(id),
        fields: { account: { login, id, type }, repositorySelection: selection },
      };
    },
  );
});
