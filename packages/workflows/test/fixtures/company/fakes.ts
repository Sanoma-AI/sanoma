import { fakeGithub, fakeStripe, type FakeGithubState } from "@sanoma/testing";
import { readResources } from "../../../src/describe.ts";
import company from "./sanoma.config.ts";

/** Each resource type's provider type, and a recorded object of it to copy, when the fakes have one. */
const PROVIDER: Record<string, { typeName: string; template?: string }> = {
  "github.repository": { typeName: "github_repository", template: "github_repository/sanoma" },
  "github.branch_protection": { typeName: "github_branch_protection" },
  "stripe.product": { typeName: "stripe_product", template: "stripe_product/prod_SanomaTest0001" },
  "stripe.webhook_endpoint": {
    typeName: "stripe_webhook_endpoint",
    template: "stripe_webhook_endpoint/we_SanomaTest0001",
  },
};

/**
 * The company's GitHub and Stripe, as fakes. `seed()` resets them and gives them an object for
 * each resource the data files declare, holding what it declares: a recorded object of its type
 * copied (so it has the fields the vendor sets), or a new one, under its import id, with the
 * declared fields over it. A test then changes one with `override` or `remove`.
 */
export function companyFakes() {
  const github = fakeGithub();
  const stripe = fakeStripe();
  const declared = readResources(company);
  function seed() {
    github.reset();
    stripe.reset();
    for (const r of declared) {
      const fake = r.vendor === "github" ? github : stripe;
      const { typeName, template } = PROVIDER[`${r.vendor}.${r.type}`]!;
      fake.update((state: FakeGithubState) => {
        const copied = template && state.objects[template];
        const object =
          copied && !("error" in copied)
            ? structuredClone(copied)
            : { typeName, state: {}, private: "", schemaVersion: 0 };
        // A read finds the object by its state's id: a repository's is its name, a rule's GitHub's own.
        object.state.id = r.type === "branch_protection" ? `BP_${r.name}` : r.name;
        state.objects[`${typeName}/${r.name}`] = object;
      });
      (fake.override as (type: string, id: string, fields: Record<string, unknown>) => void)(r.type, r.name, r.desired);
    }
  }
  return { github, stripe, drivers: [github.driver, stripe.driver], declared, seed };
}
