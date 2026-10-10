import { fakeGithub } from "@sanoma/connector-github/fake";
import { fakeStripe } from "@sanoma/connector-stripe/fake";
import { readResources } from "../../../src/describe.ts";
import company from "./sanoma.config.ts";

/** GitHub's node id for a repository, as the fake holds it: what a rule's `repository_id` holds. */
export const nodeIdOf = (repository: string) => `R_${repository}`;

/**
 * The company's GitHub and Stripe, as fakes. `seed()` resets them and puts an object for each
 * resource the data files declare, holding what it declares the way the vendor would: over a
 * recorded object of its type where there is one (so it has the fields the vendor sets), a
 * repository with its node id, and a branch protection rule naming its repository by that node
 * id, as GitHub's provider does. A test then changes one with `override` or `remove`.
 */
export function companyFakes() {
  const github = fakeGithub();
  const stripe = fakeStripe();
  const declared = readResources(company);
  function seed() {
    github.reset();
    stripe.reset();
    for (const { vendor, type, name, desired } of declared) {
      const key = `${vendor}.${type}`;
      if (key === "github.repository") {
        github.put("repository", name, { ...desired, node_id: nodeIdOf(name) }, { from: "sanoma" });
      } else if (key === "github.branch_protection") {
        const { repository_id } = desired as { repository_id: string };
        github.put("branch_protection", name, {
          ...desired,
          id: `BPR_${name}`,
          repository_id: nodeIdOf(repository_id),
        });
      } else if (key === "stripe.product") {
        stripe.put("product", name, desired, { from: "prod_SanomaTest0001" });
      } else if (key === "stripe.webhook_endpoint") {
        stripe.put("webhook_endpoint", name, desired, { from: "we_SanomaTest0001" });
      } else {
        throw new Error(`companyFakes: no fake holds ${key}`);
      }
    }
  }
  return { github, stripe, drivers: [github.driver, stripe.driver], declared, seed };
}
