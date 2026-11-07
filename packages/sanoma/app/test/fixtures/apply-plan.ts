import type { ApplyPlan } from "@sanoma-ai/workflows/describe";

/** An apply plan with one of each kind of step, over the workflows' company fixture, plus a problem and a rebind. */
export const PLAN: ApplyPlan = {
  problems: [
    { file: "resources/identity/rules.ts", line: 3, column: 1, message: "export const strict: not a resource" },
  ],
  rebinds: [
    {
      key: "resources/identity/github.ts#docs",
      type: "github.repository",
      kind: "rebind",
      from: "R_kgDOabcd1234",
      to: "R_kgDOwxyz5678",
    },
  ],
  steps: [
    {
      id: "resources/identity/github.ts#blog",
      vendor: "github",
      type: "repository",
      action: "create",
      planned: { name: "blog", visibility: "private", node_id: null },
      unknown: ["node_id"],
    },
    {
      id: "resources/identity/github.ts#website",
      vendor: "github",
      type: "repository",
      action: "update",
      binding: "R_website",
      fields: [{ path: "has_wiki", desired: false, actual: true }],
      replace: [],
    },
    {
      id: "resources/identity/github.ts#websiteMain",
      vendor: "github",
      type: "branch_protection",
      action: "replace",
      binding: "BPR_website:main",
      fields: [{ path: "pattern", desired: "main", actual: "master" }],
      replace: ["pattern"],
    },
    {
      id: "resources/billing/stripe.ts#basic",
      vendor: "stripe",
      type: "product",
      action: "bind",
      binding: "prod_SanomaFixtureBasic",
      source: "found",
    },
    {
      id: "resources/billing/stripe.ts#pro",
      vendor: "stripe",
      type: "product",
      action: "gone",
      binding: "prod_SanomaFixturePro",
    },
    {
      id: "resources/old.ts#legacy",
      vendor: "github",
      type: "repository",
      action: "orphan",
      key: "resources/old.ts#legacy",
      binding: "R_kgDOlegacy99",
    },
    {
      id: "resources/identity/github.ts#docs",
      vendor: "github",
      type: "repository",
      action: "none",
      binding: "R_docs",
    },
  ],
};
