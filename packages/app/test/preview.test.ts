import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allow,
  allowAll,
  cedarPolicy,
  defineConnector,
  definePolicy,
  defineWorkflow,
  loadPolicies,
  type Policy,
  resolveConfig,
} from "@sanoma-ai/workflows";
import { describeConfig, readPeople } from "@sanoma-ai/workflows/describe";
import { defineFake } from "@sanoma-ai/workflows/fake";
import { withFake } from "@sanoma-ai/testing";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ACTOR_HEADER } from "../src/api.ts";
import type { AppContext } from "../src/context.ts";
import { previewRequests, willAsk } from "../src/lib/preview.ts";
import { admitting } from "../src/login/admission.ts";
import { loopbackLogin } from "../src/loopback.ts";
import { actorOf, preview, requireActor } from "../src/server/core.ts";

// The run form's "will ask" line: `previewFn`'s core, asked as the person the loopback login
// admits, over a workflow's start and the operations its outline calls. No database: nothing runs.

const shop = defineConnector("shop", {
  refunds: {
    create: { effect: "money", input: z.object({ amount: z.number().int() }), output: z.object({ id: z.string() }) },
  },
});
const fake = defineFake(shop, {
  initial: () => ({}),
  ops: () => ({ refunds: { create: async () => ({ id: "re_1" }) } }),
});
const refund = defineWorkflow({
  name: "refund",
  trigger: "manual",
  input: z.object({ amount: z.number().int() }),
  uses: [shop.refunds.create],
  run: async (ctx, { amount }) => ctx.shop.refunds.create({ amount }),
});

const root = mkdtempSync(join(tmpdir(), "sanoma-preview-"));
mkdirSync(join(root, "resources"));
writeFileSync(
  join(root, "resources", "people.ts"),
  `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
export const bo = sanoma.person({ id: "bo" });
export const finance = sanoma.group({ name: "finance", members: [ada] });
`,
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const POLICIES = `@hold("finance")
@title("Refunds need finance")
forbid (principal, action == Sanoma::Action::"workflow:refund", resource)
unless { principal in Sanoma::Group::"finance" };

@id("money-is-finance's")
@reason("Only finance moves money")
forbid (principal, action in Sanoma::Action::"effect:money", resource)
unless { principal in Sanoma::Group::"finance" };
`;

const config = { workflows: [refund], connectors: [withFake(shop, fake)], root };
const resolved = resolveConfig({ ...config });
const cedar = cedarPolicy(
  resolved,
  loadPolicies([{ file: "policies/refunds.cedar", text: POLICIES }]).policies,
  readPeople(root).people,
);
const description = describeConfig({ ...config });
const requests = previewRequests(description.workflows[0]!, new Map(description.ops.map((op) => [op.id, op])));

/** The line the run form shows `who`, named in the loopback login's header, under `policy`. */
async function lineFor(policy: Policy, who: string) {
  const app = {
    resolved: { ...resolved, policy },
    login: admitting(loopbackLogin(), () => readPeople(root)),
  } as unknown as AppContext;
  const request = new Request("http://localhost/_serverFn", { headers: { [ACTOR_HEADER]: who } });
  const actor = await requireActor({ app, actor: actorOf(app, request) });
  return willAsk(requests, preview(app, actor, requests));
}

describe("the will-ask line", () => {
  it("asks the start and each operation the outline calls, with its effect", () => {
    expect(requests).toEqual([
      { action: { id: "workflow:refund" } },
      { action: { id: "shop.refunds.create", effect: "money" } },
    ]);
  });

  it("names whom a hold asks, and a deny's rule with its reason, for the person asking", async () => {
    expect(await lineFor(cedar, "bo")).toBe(
      "Will ask finance before the start. money-is-finance's refuses shop.refunds.create: Only finance moves money.",
    );
    expect(await lineFor(cedar, "ada")).toBeUndefined();
  });

  it("says nothing under allowAll, and that a function policy cannot be asked ahead", async () => {
    expect(await lineFor(allowAll, "bo")).toBeUndefined();
    expect(
      await lineFor(
        definePolicy(() => allow()),
        "bo",
      ),
    ).toBe("This policy cannot be asked ahead.");
  });

  it("says when the input decides, naming the rule", () => {
    const depends = willAsk(requests, [
      { answer: "allow" },
      { answer: "depends", rule: { id: "big", file: "policies/a.cedar", title: "Big refunds" } },
    ]);
    expect(depends).toBe("Big refunds may hold shop.refunds.create, depending on the input.");
  });
});
