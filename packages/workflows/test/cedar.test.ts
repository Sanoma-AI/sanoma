import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decideCall } from "../src/call.ts";
import { defineFake } from "../src/fake.ts";
import { collection } from "../src/data.ts";
import type { ApprovalState } from "../src/define.ts";
import { describeConfig, generateSchema, SCHEMA_FILE, writeSchema } from "../src/describe.ts";
import {
  cedarPolicy,
  defineConfig,
  defineConnector,
  defineWorkflow,
  memoryLedger,
  type Policy,
  type PolicyCall,
  policiesOf,
  policyOpOf,
  readPolicyFiles,
  validatePolicies,
} from "../src/index.ts";
import { withFake } from "@sanoma-ai/testing";

// The two policies of the Cedar investigation, against made-up operations: refunds over 10,000
// held for finance, and only sales may mark a lead won; and agents held for whom they act for.
const shop = defineConnector("shop", {
  refunds: {
    create: {
      effect: "money",
      input: z.object({ amount: z.number().int(), customer: z.string(), rate: z.number().optional() }),
      output: z.object({ id: z.string() }),
    },
  },
  notes: {
    add: { effect: "write", input: z.object({ text: z.string() }), output: z.object({}) },
  },
});
const leads = collection({
  name: "leads",
  key: "id",
  fields: { id: "text", stage: { enum: ["open", "won"] }, owner: { type: "person", optional: true } },
});
const refund = defineWorkflow({
  name: "refund",
  trigger: "manual",
  input: z.object({ amount: z.number().int() }),
  uses: [shop.refunds.create],
  run: async (ctx, { amount }) => ctx.shop.refunds.create({ amount, customer: "c" }),
});
const config = defineConfig({
  workflows: [refund],
  connectors: [
    withFake(
      shop,
      defineFake(shop, {
        initial: () => ({}),
        ops: () => ({ refunds: { create: async () => ({ id: "re_1" }) }, notes: { add: async () => ({}) } }),
      }),
    ),
  ],
  collections: [leads],
  ledger: memoryLedger(),
});

const people = {
  people: [{ id: "ada" }, { id: "bo" }, { id: "cy" }, { id: "refund-bot", onBehalfOf: "bo" }],
  groups: [
    { name: "finance", members: ["ada"] },
    { name: "sales", members: ["bo", "refund-bot"] },
    { name: "agents", members: ["refund-bot"] },
  ],
};

const FILES = [
  {
    file: "policies/money.cedar",
    text: `// Refunds over 10,000.00, in minor units.
@hold("finance")
@title("Refund over 10,000")
forbid (principal, action in Sanoma::Action::"effect:money", resource)
when { context.input.amount > 1000000 }
unless { principal in Sanoma::Group::"finance" };
`,
  },
  {
    file: "policies/leads.cedar",
    text: `@id("leads-won")
@reason("Only sales may mark a lead won")
forbid (principal, action == Sanoma::Action::"data.leads.save", resource in Sanoma::Collection::"leads")
when { context.input.record.stage == "won" && (if context has before then context.before.stage != "won" else true) }
unless { principal in Sanoma::Group::"sales" };

@hold("on-behalf-of")
forbid (principal in Sanoma::Group::"agents", action in Sanoma::Action::"effect:money", resource);
`,
  },
];

const schema = generateSchema(describeConfig(config), people);
const made = policiesOf(FILES);
const policy = cedarPolicy({ policies: made.policies, schema: schema.json, people });

const run = (approvals: ApprovalState[] = []) => ({ id: "r1", workflow: "refund", approvals });
const refundCall = (amount: number, actor: string, approvals?: ApprovalState[]): PolicyCall => ({
  op: policyOpOf(shop.refunds.create),
  effect: "money",
  input: { amount, customer: "cus_1", rate: 0.5 },
  actor: { id: actor },
  run: run(approvals),
});
const saveCall = (actor: string, stage: string, before?: { id: string; stage: string }): PolicyCall => ({
  op: policyOpOf(leads.save),
  effect: "write",
  target: "data:leads/l1",
  input: { record: { id: "l1", stage } },
  actor: { id: actor },
  run: { id: "direct:x", workflow: "call", approvals: [] },
  mount: "direct",
  ...(before && { before }),
});
const approved = (approver: ApprovalState["approver"], by: string): ApprovalState => ({
  id: "approval-1",
  title: "Refund over 10,000",
  approver,
  requestedBy: "policy",
  covers: ["shop.refunds.create"],
  status: "approved",
  requestedAt: 0,
  decidedBy: by,
  refused: [],
});

describe("generateSchema", () => {
  it("has every operation in its effect's group, workflow starts, collection views, and the declared groups", () => {
    expect(schema.text).toContain('entity Group enum ["agents", "finance", "sales"];');
    expect(schema.text).toContain("entity Principal in [Group] = {\n    onBehalfOf?: Principal\n  };");
    expect(schema.text).toContain('action "shop.refunds.create" in [Action::"effect:money"] appliesTo {');
    expect(schema.text).toContain('action "data.leads.save" in [Action::"effect:write"] appliesTo {');
    expect(schema.text).toContain('action "workflow:refund" appliesTo {');
    expect(schema.text).toContain('action "collection:leads" in [Action::"view"] appliesTo {');
    expect(schema.text).toContain("amount: Long");
    expect(schema.text).toMatch(/before\?: \{\n\s+id: String,\n\s+owner\?: String,\n\s+stage: String\n\s+\}/);
  });

  it("types a decimal as a String and leaves out what Cedar cannot type, each a problem", () => {
    expect(schema.problems).toContain(
      "shop.refunds.create: input.rate is a decimal number, a String in the schema: z.number().int() makes it a Long",
    );
    expect(schema.problems).toContainEqual(
      expect.stringMatching(/^data\.leads\.list: input\.where\.stage is left out/),
    );
    expect(schema.text).toContain("rate?: String");
  });

  it("enumerates no group when none is declared, so a policy may name any", () => {
    expect(generateSchema(describeConfig(config), { people: [], groups: [] }).text).toContain("entity Group;");
  });

  it("is written to .sanoma/schema.cedarschema only when it changed", async () => {
    const root = mkdtempSync(join(tmpdir(), "sanoma-schema-"));
    try {
      const description = describeConfig(config);
      expect((await writeSchema(root, description, people)).wrote).toBe(true);
      expect(readFileSync(join(root, SCHEMA_FILE), "utf8")).toBe(schema.text);
      expect((await writeSchema(root, description, people)).wrote).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("policiesOf and validatePolicies", () => {
  it("names each policy <file>#<n>, or by its @id, at the line it starts on", () => {
    expect(made.problems).toEqual([]);
    expect(made.policies.map(({ id, file, line }) => ({ id, file, line }))).toEqual([
      { id: "policies/money.cedar#1", file: "policies/money.cedar", line: 2 },
      { id: "leads-won", file: "policies/leads.cedar", line: 1 },
      { id: "policies/leads.cedar#2", file: "policies/leads.cedar", line: 7 },
    ]);
    expect(validatePolicies(made.policies, schema.json)).toEqual([]);
  });

  it("reports a misspelled field and an undeclared group at their file, line and column", () => {
    const { policies } = policiesOf([
      {
        file: "policies/bad.cedar",
        text: `\nforbid (principal, action == Sanoma::Action::"data.leads.save", resource)\nwhen { context.input.record.stag == "won" };\n\nforbid (principal in Sanoma::Group::"finanse", action, resource);\n`,
      },
    ]);
    expect(validatePolicies(policies, schema.json)).toEqual([
      expect.objectContaining({
        file: "policies/bad.cedar",
        line: 3,
        column: 8,
        policy: "policies/bad.cedar#1",
        message: expect.stringContaining("attribute `input.record.stag`"),
      }),
      expect.objectContaining({
        line: 5,
        policy: "policies/bad.cedar#2",
        message: expect.stringContaining('`"finanse"` is not declared as a valid eid'),
      }),
    ]);
  });

  it("reports a file that does not parse, a template and two policies with one id", () => {
    const { problems } = policiesOf([
      { file: "policies/a.cedar", text: '@id("x") forbid (principal, action, resource);\n' },
      { file: "policies/b.cedar", text: '\n@id("x") forbid (principal, action, resource);\n' },
      { file: "policies/c.cedar", text: "forbid (principal == ?principal, action, resource);\n" },
      { file: "policies/d.cedar", text: "\nforbid (principal, action, resource) when { ;\n" },
    ]);
    expect(problems).toEqual([
      { file: "policies/b.cedar", line: 2, column: 1, message: 'two policies have the id "x": give one another @id' },
      expect.objectContaining({ file: "policies/c.cedar", line: 1, message: expect.stringContaining("template") }),
      expect.objectContaining({ file: "policies/d.cedar", line: 2 }),
    ]);
  });

  it("reads policies/**/*.cedar under a root, sorted", () => {
    const root = mkdtempSync(join(tmpdir(), "sanoma-policies-"));
    try {
      mkdirSync(join(root, "policies/team"), { recursive: true });
      writeFileSync(join(root, "policies/z.cedar"), "z");
      writeFileSync(join(root, "policies/team/a.cedar"), "a");
      writeFileSync(join(root, "policies/policy.ts"), "");
      expect(readPolicyFiles(root)).toEqual([
        { file: "policies/team/a.cedar", text: "a" },
        { file: "policies/z.cedar", text: "z" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cedarPolicy", () => {
  it("allows what no forbid refuses", async () => {
    expect(await policy(refundCall(500_000, "bo"))).toEqual({ kind: "allow", reasons: ["allow-by-default"] });
    expect(await policy(refundCall(2_000_000, "ada"))).toMatchObject({ kind: "allow" });
  });

  it("holds a refund over 10,000 for finance, with the policy's title and id", async () => {
    expect(await policy(refundCall(2_000_000, "bo"))).toEqual({
      kind: "approve",
      approver: { group: "finance" },
      rule: "policies/money.cedar#1",
      title: "Refund over 10,000",
    });
  });

  it("lifts the hold once an approval for finance covering the operation is approved", async () => {
    expect(await policy(refundCall(2_000_000, "bo", [approved({ group: "finance" }, "ada")]))).toEqual({
      kind: "allow",
      reasons: ["policies/money.cedar#1"],
      rule: "policies/money.cedar#1",
    });
    // An approval addressed to someone else lifts nothing.
    expect(await policy(refundCall(2_000_000, "bo", [approved("cy", "cy")]))).toMatchObject({ kind: "approve" });
  });

  it("holds an agent's refund for whom it acts for, then for finance", async () => {
    expect(await policy(refundCall(2_000_000, "refund-bot"))).toMatchObject({
      kind: "approve",
      approver: { group: "finance" },
    });
    expect(await policy(refundCall(5, "refund-bot"))).toMatchObject({ kind: "approve", approver: "bo" });
    expect(await policy(refundCall(5, "refund-bot", [{ ...approved("bo", "bo") }]))).toMatchObject({ kind: "allow" });
  });

  it("denies a lead marked won by someone not in sales, with the policy's reason", async () => {
    expect(await policy(saveCall("ada", "won"))).toEqual({
      kind: "deny",
      reason: "Only sales may mark a lead won",
      reasons: ["leads-won"],
      rule: "leads-won",
    });
    expect(await policy(saveCall("bo", "won"))).toMatchObject({ kind: "allow" });
    expect(await policy(saveCall("ada", "won", { id: "l1", stage: "won" }))).toMatchObject({ kind: "allow" });
    expect(await policy(saveCall("ada", "open"))).toMatchObject({ kind: "allow" });
  });

  it("denies a hold whose approver names no one", async () => {
    const { policies } = policiesOf([
      {
        file: "policies/x.cedar",
        text: '@hold("nobody") forbid (principal, action == Sanoma::Action::"shop.notes.add", resource);',
      },
    ]);
    const odd = cedarPolicy({ policies, schema: schema.json, people });
    expect(
      await odd({
        op: policyOpOf(shop.notes.add),
        effect: "write",
        input: { text: "t" },
        actor: { id: "bo" },
        run: run(),
      }),
    ).toMatchObject({ kind: "deny", reason: "cannot resolve approver", rule: "policies/x.cedar#1" });
  });

  it("is versioned by its text and lists its rules", () => {
    expect(policy.version).toMatch(/^[0-9a-f]{12}$/);
    expect(cedarPolicy({ policies: made.policies.slice(1), schema: schema.json, people }).version).not.toBe(
      policy.version,
    );
    expect(policy.rules).toEqual([
      {
        id: "policies/money.cedar#1",
        file: "policies/money.cedar",
        effect: "forbid",
        hold: "finance",
        title: "Refund over 10,000",
      },
      { id: "leads-won", file: "policies/leads.cedar", effect: "forbid", reason: "Only sales may mark a lead won" },
      { id: "policies/leads.cedar#2", file: "policies/leads.cedar", effect: "forbid", hold: "on-behalf-of" },
    ]);
    expect(describeConfig({ ...config, policy }).policy).toEqual({
      defined: true,
      kind: "cedar",
      rules: policy.rules,
      version: policy.version,
    });
  });

  it("records the rule and title through decideCall", async () => {
    const decided = await decideCall(
      policy,
      shop.refunds.create,
      { amount: 2_000_000, customer: "c" },
      { id: "bo" },
      run(),
    );
    expect(decided).toEqual({
      kind: "approve",
      approver: { group: "finance" },
      rule: "policies/money.cedar#1",
      title: "Refund over 10,000",
      policyVersion: policy.version,
    });
  });
});

const preview = (principal: string, action: string, context = {}) =>
  policy.preview!({ principal: { id: principal }, action, context });

describe("preview", () => {
  it("says hold, deny or allow when the known parts decide it, and depends when the unknown ones do", () => {
    expect(preview("bo", "shop.refunds.create", { input: { amount: 2_000_000, customer: "c" } })).toBe("hold");
    expect(preview("bo", "shop.refunds.create", { input: { amount: 5, customer: "c" } })).toBe("allow");
    expect(preview("bo", "shop.refunds.create")).toBe("depends");
    expect(preview("ada", "shop.refunds.create")).toBe("allow");
    expect(preview("refund-bot", "shop.refunds.create")).toBe("hold");
    const won = { input: { record: { id: "l1", stage: "won" } } };
    // Whether it was won before decides it.
    expect(preview("ada", "data.leads.save", won)).toBe("depends");
    expect(preview("ada", "data.leads.save", { ...won, before: { id: "l1", stage: "open" } })).toBe("deny");
    expect(preview("bo", "collection:leads", { mount: "view" })).toBe("allow");
    expect(preview("bo", "workflow:refund")).toBe("allow");
  });

  it("is custom for a policy written as a function", async () => {
    const { definePolicy, allow, allowAll } = await import("../src/index.ts");
    const fn: Policy = definePolicy(() => allow());
    expect(fn.preview!({ principal: { id: "bo" }, action: "shop.refunds.create" })).toBe("custom");
    expect(allowAll.preview!({ principal: { id: "bo" }, action: "shop.refunds.create" })).toBe("allow");
  });
});
