import { withFake } from "@sanoma-ai/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { columnPrincipal, describeConfig, permissionsGrid, readPeople } from "../src/describe.ts";
import { defineFake } from "../src/fake.ts";
import {
  allowAll,
  cedarPolicy,
  defineConnector,
  defineWorkflow,
  loadPolicies,
  type Policy,
  resolveConfig,
  type SanomaConfig,
} from "../src/index.ts";
import { rootWith } from "./harness.ts";

// The Permissions grid (`permissionsGrid`): what the policy would answer each group, as the app's
// Permissions page and `sanoma check` both report it.

const shop = defineConnector("shop", {
  refunds: {
    create: { effect: "money", input: z.object({ amount: z.number().int() }), output: z.object({ id: z.string() }) },
    list: { effect: "read", input: z.object({}), output: z.array(z.object({ id: z.string() })) },
  },
});
const fake = defineFake(shop, {
  initial: () => ({}),
  ops: () => ({ refunds: { create: async () => ({ id: "re_1" }), list: async () => [] } }),
});
const refund = defineWorkflow({
  name: "refund",
  title: "Refund",
  trigger: "manual",
  input: z.object({ amount: z.number().int() }),
  uses: [shop.refunds.create],
  run: async (ctx, { amount }) => ctx.shop.refunds.create({ amount }),
});

// A hold on a start, a deny on a direct read and a hold on an operation only a run calls, each
// for those outside a group.
const POLICIES = `@hold("finance")
@title("Refunds need finance")
forbid (principal, action == Sanoma::Action::"workflow:refund", resource)
unless { principal in Sanoma::Group::"finance" };

@id("no-agent-reads")
@reason("Agents read no refunds")
forbid (principal in Sanoma::Group::"agents", action == Sanoma::Action::"shop.refunds.list", resource);

@id("agent-refunds")
@hold("finance")
@title("Agent refunds need finance")
forbid (principal in Sanoma::Group::"agents", action == Sanoma::Action::"shop.refunds.create", resource);
`;

const root = rootWith({
  "resources/people.ts": `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada", name: "Ada Lovelace" });
export const bo = sanoma.person({ id: "bo" });
export const refundBot = sanoma.agent({ id: "refund-bot", onBehalfOf: bo });
export const finance = sanoma.group({ name: "finance", members: [ada] });
`,
  "policies/refunds.cedar": POLICIES,
});

const config: SanomaConfig = { workflows: [refund], connectors: [withFake(shop, fake)], root };
// The root's policy, made from policies/refunds.cedar.
const resolved = resolveConfig(config);
const cedar = resolved.policy;
const description = describeConfig(config);

/** A public site, so the grid shows a visitor's columns. */
const site = { name: "www", public: true as const, pages: [], calls: [], problems: [], warnings: [] };

/** The grid under `policy`, beside a public site. */
const gridOf = (policy: Policy) => permissionsGrid({ policy }, { ...description, sites: [site] });

describe("permissionsGrid", () => {
  const hold = {
    answer: "hold",
    rule: { id: "policies/refunds.cedar#1", file: "policies/refunds.cedar", title: "Refunds need finance" },
    approver: { group: "finance" },
  };

  // A visitor, signed in or not, whom no permit lets start a run or call directly.
  const visitorDenied = [{ answer: "deny" }, { answer: "deny" }];

  it("asks the policy for someone in no group and in each group, the start of each workflow, the operations it uses and each direct operation", () => {
    const grid = gridOf(cedar);
    expect(grid.groups).toEqual([null, "agents", "finance", "visitors", "anonymous"]);
    expect(grid.workflows).toEqual([
      {
        id: "refund",
        title: "Refund",
        // Someone in finance is not held: the hold's own approver.
        cells: [hold, hold, { answer: "allow" }, ...visitorDenied],
        // The money operation, called only in a run, under the workflow that uses it.
        ops: [
          {
            id: "shop.refunds.create",
            cells: [
              { answer: "allow" },
              {
                answer: "hold",
                rule: { id: "agent-refunds", file: "policies/refunds.cedar", title: "Agent refunds need finance" },
                approver: { group: "finance" },
              },
              { answer: "allow" },
              // In a run a visitor was let start, its calls are anyone's.
              { answer: "allow" },
              { answer: "allow" },
            ],
          },
        ],
      },
    ]);
    expect(grid.ops).toEqual([
      // The runtime's listing of apps, which a page may call: a visitor only with a permit.
      { id: "sanoma.apps.list", cells: [...Array.from({ length: 3 }, () => ({ answer: "allow" })), ...visitorDenied] },
      ...[
        "sanoma.connection.activate",
        "sanoma.connection.bind",
        "sanoma.connection.configure",
        "sanoma.connection.create",
        "sanoma.connection.disconnect",
        "sanoma.connection.prepare",
        "sanoma.connection.test",
      ].map((id) => ({
        id,
        cells: [...Array.from({ length: 3 }, () => ({ answer: "allow" })), ...visitorDenied],
      })),
      {
        // A money operation is called only in a run: not a direct row.
        id: "shop.refunds.list",
        cells: [
          { answer: "allow" },
          {
            answer: "deny",
            rule: { id: "no-agent-reads", file: "policies/refunds.cedar", reason: "Agents read no refunds" },
          },
          { answer: "allow" },
          ...visitorDenied,
        ],
      },
    ]);
  });

  it("shows a visitor's columns only beside a public site", () => {
    expect(permissionsGrid(resolved, description).groups).toEqual([null, "agents", "finance"]);
    expect(gridOf(cedar).groups).toEqual([null, "agents", "finance", "visitors", "anonymous"]);
  });

  it("holds an agent for whom it acts for, and refuses everyone else that hold", () => {
    const onBehalf = cedarPolicy(
      resolved,
      loadPolicies([
        {
          file: "policies/agents.cedar",
          text: '@hold("on-behalf-of")\nforbid (principal, action == Sanoma::Action::"shop.refunds.list", resource);\n',
        },
      ]).policies,
      readPeople(root).people,
    );
    const rule = { id: "policies/agents.cedar#1", file: "policies/agents.cedar" };
    expect(gridOf(onBehalf).ops.find((row) => row.id === "shop.refunds.list")!.cells).toEqual([
      { answer: "deny", rule },
      { answer: "hold", rule, approver: "whom it acts for" },
      { answer: "deny", rule },
      ...visitorDenied,
    ]);
  });

  it("is every cell allow with no policy, but a visitor's start and direct call", () => {
    const none = gridOf(allowAll);
    const allowed = Array.from({ length: 3 }, () => ({ answer: "allow" }));
    expect([...none.workflows, ...none.workflows.flatMap((w) => w.ops), ...none.ops].map((row) => row.cells)).toEqual([
      [...allowed, ...visitorDenied],
      [...allowed, { answer: "allow" }, { answer: "allow" }],
      [...allowed, ...visitorDenied],
      [...allowed, ...visitorDenied],
      [...allowed, ...visitorDenied],
      [...allowed, ...visitorDenied],

      [...allowed, ...visitorDenied],
      [...allowed, ...visitorDenied],
      [...allowed, ...visitorDenied],
      [...allowed, ...visitorDenied],
      [...allowed, ...visitorDenied],
    ]);
  });

  it("asks each column as someone in that group alone, an agent acting for someone, a visitor or anonymous", () => {
    expect([null, "finance", "agents", "visitors", "anonymous"].map(columnPrincipal)).toEqual([
      { id: "group:", groups: [] },
      { id: "group:finance", groups: ["finance"] },
      { id: "group:agents", groups: ["agents"], onBehalfOf: "whom it acts for" },
      { id: "visitor:grid:visitor", groups: ["visitors"] },
      { id: "anonymous", groups: [] },
    ]);
  });
});
