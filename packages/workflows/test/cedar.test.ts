import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabaseUrl, withFake } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { decideCall } from "../src/call.ts";
import { sanoma } from "../src/constructors.ts";
import { collection } from "../src/data.ts";
import type { ApprovalState, Principal } from "../src/define.ts";
import { describeConfig, SCHEMA_FILE, schemaOf, schemaText, writeGenerated } from "../src/describe.ts";
import { defineFake } from "../src/fake.ts";
import {
  allowAll,
  cedarPolicy,
  defineConfig,
  defineConnector,
  defineWorkflow,
  loadPolicies,
  memoryLedger,
  SanomaClient,
  type PolicyCall,
  policyOpOf,
  readPolicyFiles,
  resolveConfig,
  validatePolicies,
  VISITOR_DENIED,
} from "../src/index.ts";
import { ANONYMOUS_PRINCIPAL, visitorPrincipal } from "../src/shared.ts";
import { startWorker } from "../src/worker.ts";
import { failure, rootWith, waitFor } from "./harness.ts";

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
  tags: {
    set: {
      effect: "write",
      input: z.object({ tags: z.string().transform((s) => s.split(",")) }),
      output: z.object({}),
    },
  },
  notes: {
    add: {
      effect: "write",
      input: z.object({ text: z.string(), tags: z.record(z.string(), z.string()) }),
      output: z.object({}),
    },
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
const fake = defineFake(shop, {
  initial: () => ({}),
  ops: () => ({
    refunds: { create: async () => ({ id: "re_1" }) },
    tags: { set: async () => ({}) },
    notes: { add: async () => ({}) },
  }),
});
const config = defineConfig({
  workflows: [refund],
  connectors: [withFake(shop, fake)],
  collections: [leads],
  ledger: memoryLedger(),
});
const resolved = resolveConfig(config);

const [ada, bo, cy] = ["ada", "bo", "cy"].map((id) => sanoma.person({ id }));
const refundBot = sanoma.agent({ id: "refund-bot", onBehalfOf: bo! });
const people = [
  ada!,
  bo!,
  cy!,
  refundBot,
  sanoma.group({ name: "finance", members: [ada!] }),
  sanoma.group({ name: "sales", members: [bo!, refundBot] }),
];

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

const schema = schemaOf(resolved, people);
const text = schemaText(schema);
const loaded = loadPolicies(FILES);
const policy = cedarPolicy(resolved, loaded.policies, people);

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

describe("schemaOf", () => {
  it("has the declared groups, agents and visitors, every operation in its effect's group and every workflow in start", () => {
    expect(text).toContain('entity Group enum ["agents", "finance", "sales", "visitors"];');
    expect(text).toContain("entity Principal in [Group] = {\n    onBehalfOf?: Principal\n  };");
    expect(text).toContain("entity Target in [Collection];");
    expect(text).toContain('action "shop.refunds.create" in [Action::"effect:money"] appliesTo {');
    expect(text).toContain('action "data.leads.save" in [Action::"effect:write"] appliesTo {');
    expect(text).toContain('action "workflow:refund" in [Action::"start"] appliesTo {');
    expect(text).not.toMatch(/\bmount\b|approverGroups|"site:|"collection:/);
  });

  it("types the input from its zod schema, a collection's save with the record as it was", () => {
    expect(text).toMatch(/amount: Long,\s+customer: String,\s+rate\?: String/);
    expect(text).toMatch(/before\?: \{\n\s+id: String,\n\s+owner\?: String,\n\s+stage: String\n\s+\}/);
    // A map has no Cedar type: left out.
    expect(text).toMatch(/action "shop\.notes\.add"[^;]*input: \{\n\s+text: String\n\s+\}/);
  });

  it("is written with api.ts as the generated files, each only when it changed", async () => {
    const root = mkdtempSync(join(tmpdir(), "sanoma-schema-"));
    try {
      const description = describeConfig(config);
      expect((await writeGenerated(root, description, schema)).wrote).toEqual([".sanoma/api.ts", SCHEMA_FILE]);
      expect(readFileSync(join(root, SCHEMA_FILE), "utf8")).toBe(text);
      expect((await writeGenerated(root, description, schema)).wrote).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadPolicies and validatePolicies", () => {
  it("reads each policy in the order written, named <file>#<n> or by its @id, with its annotations", () => {
    expect(loaded.problems).toEqual([]);
    expect(
      loaded.policies.map(({ id, file, line, effect, hold, title, reason }) => ({
        id,
        file,
        line,
        effect,
        hold,
        title,
        reason,
      })),
    ).toEqual([
      {
        id: "policies/money.cedar#1",
        file: "policies/money.cedar",
        line: 2,
        effect: "forbid",
        hold: "finance",
        title: "Refund over 10,000",
      },
      {
        id: "leads-won",
        file: "policies/leads.cedar",
        line: 1,
        effect: "forbid",
        reason: "Only sales may mark a lead won",
      },
      { id: "policies/leads.cedar#2", file: "policies/leads.cedar", line: 7, effect: "forbid", hold: "on-behalf-of" },
    ]);
    expect(validatePolicies(resolved, loaded.policies, people)).toEqual([]);
  });

  it("keeps the order written past ten policies, which Cedar's parts sort as text", () => {
    const many = Array.from({ length: 12 }, (_, n) => `forbid (principal, action, resource) when { ${n} == 1 };`);
    const { policies } = loadPolicies([{ file: "policies/many.cedar", text: many.join("\n") }]);
    expect(policies.map((p) => [p.id, p.line])).toEqual(many.map((_, n) => [`policies/many.cedar#${n + 1}`, n + 1]));
    expect(policies[10]!.text).toContain("10 == 1");
  });

  it("reports a misspelled field, an undeclared group, a permit and a hold for no one, each at its place", () => {
    const { policies } = loadPolicies([
      {
        file: "policies/bad.cedar",
        text: [
          "",
          'forbid (principal, action == Sanoma::Action::"data.leads.save", resource)',
          'when { context.input.record.stag == "won" };',
          "",
          'forbid (principal in Sanoma::Group::"finanse", action, resource);',
          "permit (principal, action, resource);",
          '@hold("nobody") forbid (principal, action, resource);',
        ].join("\n"),
      },
    ]);
    expect(validatePolicies(resolved, policies, people)).toEqual([
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
      expect.objectContaining({ line: 6, message: expect.stringContaining("a permit is allowed only for visitors") }),
      expect.objectContaining({
        line: 7,
        message: '@hold("nobody") names no declared group or person, nor "on-behalf-of"',
      }),
    ]);
  });

  it("places an error in a policy that starts mid-line at its column in the file", () => {
    const { policies } = loadPolicies([
      {
        file: "policies/one.cedar",
        text: 'forbid (principal, action, resource); forbid (principal, action == Sanoma::Action::"shop.refunds.create", resource) when { context.input.amont > 1 };',
      },
    ]);
    expect(policies[1]).toMatchObject({ line: 1, column: 39 });
    expect(validatePolicies(resolved, policies, people)).toEqual([
      expect.objectContaining({ line: 1, column: 124, message: expect.stringContaining("input.amont") }),
    ]);
  });

  it("reports a file that does not parse, a template and two policies with one id", () => {
    const { problems } = loadPolicies([
      { file: "policies/a.cedar", text: '@id("x") forbid (principal, action, resource);\n' },
      { file: "policies/b.cedar", text: '\n@id("x") forbid (principal, action, resource);\n' },
      { file: "policies/c.cedar", text: "forbid (principal == ?principal, action, resource);\n" },
      { file: "policies/d.cedar", text: "\nforbid (principal, action, resource) when { ;\n" },
      { file: "policies/e.cedar", text: '@id("allow-by-default") forbid (principal, action, resource);\n' },
    ]);
    expect(problems).toEqual([
      {
        file: "policies/b.cedar",
        line: 2,
        message: 'the id "x" is another policy\'s: give this one another @id',
      },
      expect.objectContaining({ file: "policies/c.cedar", line: 1, message: expect.stringContaining("template") }),
      expect.objectContaining({ file: "policies/d.cedar", line: 2 }),
      expect.objectContaining({ file: "policies/e.cedar", message: expect.stringContaining("the runtime's own") }),
    ]);
  });

  it("reads policies/**/*.cedar under a root, sorted", () => {
    const root = mkdtempSync(join(tmpdir(), "sanoma-policies-"));
    try {
      mkdirSync(join(root, "policies/team"), { recursive: true });
      writeFileSync(join(root, "policies/z.cedar"), "z");
      writeFileSync(join(root, "policies/team/a.cedar"), "a");
      writeFileSync(join(root, "policies/README.md"), "");
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
      title: "Refund over 10,000",
      reasons: ["policies/money.cedar#1"],
    });
  });

  it("lifts the hold once an approval for finance covering the operation is approved", async () => {
    expect(await policy(refundCall(2_000_000, "bo", [approved({ group: "finance" }, "ada")]))).toEqual({
      kind: "allow",
      reasons: ["policies/money.cedar#1"],
    });
    // An approval addressed to someone else lifts nothing.
    expect(await policy(refundCall(2_000_000, "bo", [approved("cy", "cy")]))).toMatchObject({ kind: "approve" });
  });

  it("holds an agent's refund for finance first, then for whom it acts for, by default title", async () => {
    expect(await policy(refundCall(2_000_000, "refund-bot"))).toMatchObject({ approver: { group: "finance" } });
    expect(await policy(refundCall(5, "refund-bot"))).toEqual({
      kind: "approve",
      approver: "bo",
      title: "shop.refunds.create needs bo",
      reasons: ["policies/leads.cedar#2"],
    });
    expect(await policy(refundCall(5, "refund-bot", [approved("bo", "bo")]))).toMatchObject({ kind: "allow" });
  });

  it("denies a lead marked won by someone not in sales, with the policy's reason", async () => {
    expect(await policy(saveCall("ada", "won"))).toEqual({
      kind: "deny",
      reason: "Only sales may mark a lead won",
      reasons: ["leads-won"],
    });
    expect(await policy(saveCall("bo", "won"))).toMatchObject({ kind: "allow" });
    expect(await policy(saveCall("ada", "won", { id: "l1", stage: "won" }))).toMatchObject({ kind: "allow" });
    expect(await policy(saveCall("ada", "open"))).toMatchObject({ kind: "allow" });
  });

  it("denies an on-behalf-of hold for a principal acting for no one", async () => {
    const { policies } = loadPolicies([
      {
        file: "policies/x.cedar",
        text: '@hold("on-behalf-of") forbid (principal, action in Sanoma::Action::"effect:write", resource);',
      },
    ]);
    const odd = cedarPolicy(resolved, policies, people);
    const call = {
      op: policyOpOf(shop.notes.add),
      effect: "write",
      input: { text: "t", tags: {} },
      actor: { id: "bo" },
      run: run(),
    } as const;
    expect(await odd(call)).toEqual({
      kind: "deny",
      reason: "cannot resolve approver",
      reasons: ["policies/x.cedar#1"],
    });
  });

  it("types the context as the parsed input, so a transform's value does not fail the call", async () => {
    // A transform's output has no JSON Schema, so no Cedar type: left out, and the call still decided.
    expect(text).toMatch(/action "shop\.tags\.set"[^;]*input: \{\s*\}/);
    const call = {
      op: policyOpOf(shop.tags.set),
      effect: "write",
      input: { tags: ["a", "b"] },
      actor: { id: "bo" },
      run: run(),
    } as const;
    expect(await policy(call)).toMatchObject({ kind: "allow" });
  });

  it("denies a call whose input Cedar cannot hold, rather than failing it", async () => {
    const call = {
      op: policyOpOf(shop.refunds.create),
      effect: "money",
      input: { amount: Number.MAX_SAFE_INTEGER + 2, customer: "c" },
      actor: { id: "bo" },
      run: run(),
    } as const;
    expect(await policy(call)).toMatchObject({
      kind: "deny",
      reason: expect.stringMatching(/^The call does not fit the Cedar schema: .*amount/),
    });
  });

  it("is versioned by its text", () => {
    expect(policy.version).toMatch(/^[0-9a-f]{12}$/);
    expect(cedarPolicy(resolved, loaded.policies.slice(1), people).version).not.toBe(policy.version);
  });

  it("decides through decideCall, stamped with its version", async () => {
    expect(decideCall(policy, shop.refunds.create, { amount: 2_000_000, customer: "c" }, { id: "bo" }, run())).toEqual({
      kind: "approve",
      approver: { group: "finance" },
      title: "Refund over 10,000",
      reasons: ["policies/money.cedar#1"],
      policyVersion: policy.version,
    });
  });
});

const ask = (principal: string, id: string) => ({ principal: { id: principal }, action: { id } });

describe("preview", () => {
  it("answers allow, hold, deny or depends with the input unknown, naming the policy and approver", () => {
    expect(
      policy.preview([
        ask("bo", "shop.refunds.create"),
        ask("ada", "shop.refunds.create"),
        ask("refund-bot", "shop.refunds.create"),
        ask("ada", "data.leads.save"),
        ask("bo", "data.leads.save"),
        ask("bo", "workflow:refund"),
      ]),
    ).toEqual([
      {
        answer: "depends",
        rule: { id: "policies/money.cedar#1", file: "policies/money.cedar", title: "Refund over 10,000" },
      },
      { answer: "allow" },
      { answer: "hold", rule: { id: "policies/leads.cedar#2", file: "policies/leads.cedar" }, approver: "bo" },
      {
        answer: "depends",
        rule: { id: "leads-won", file: "policies/leads.cedar", reason: "Only sales may mark a lead won" },
      },
      { answer: "allow" },
      { answer: "allow" },
    ]);
  });

  it("is allow for allowAll, as is its start", () => {
    expect(allowAll.preview([ask("bo", "shop.refunds.create")])).toEqual([{ answer: "allow" }]);
    expect(allowAll.start({ id: "bo" }, "refund", {})).toEqual({ kind: "allow" });
  });

  it("is a deny for a visitor under allowAll, at a start and a direct call, but not in a run", () => {
    const visitor = visitorPrincipal("auth0", "u1");
    expect(allowAll.start(visitor, "refund", {})).toEqual({ kind: "deny", reason: VISITOR_DENIED });
    expect(allowAll.start(ANONYMOUS_PRINCIPAL, "refund", {})).toMatchObject({ kind: "deny" });
    expect(allowAll({ ...refundCall(1, "x"), actor: visitor })).toEqual({ kind: "allow" });
    expect(allowAll({ ...saveCall("x", "open"), actor: visitor })).toEqual({ kind: "deny", reason: VISITOR_DENIED });
    expect(allowAll(saveCall("bo", "open"))).toEqual({ kind: "allow" });
    const request = { principal: visitor, action: { id: "shop.refunds.create" } };
    expect(allowAll.preview([request, { ...request, inRun: true }])).toEqual([{ answer: "deny" }, { answer: "allow" }]);
  });
});

describe("visitors", () => {
  const VISITOR_FILE = {
    file: "policies/visitors.cedar",
    text: `permit (principal in Sanoma::Group::"visitors", action == Sanoma::Action::"workflow:refund", resource);
permit (principal == Sanoma::Principal::"anonymous", action == Sanoma::Action::"data.leads.save", resource);
`,
  };
  const withVisitors = loadPolicies([...FILES, VISITOR_FILE]);
  const permitting = cedarPolicy(resolved, withVisitors.policies, people);
  const visitor = visitorPrincipal("auth0", "u1");
  const direct = { id: "direct:x", workflow: "call", approvals: [] };
  const asVisitor = (call: PolicyCall, actor: Principal = visitor) => ({ ...call, actor });

  it("permits only the visitors or anonymous, scoped as written; a hold for visitors is no one", () => {
    expect(withVisitors.policies.slice(-2).map((p) => p.scope)).toEqual(["visitors", "anonymous"]);
    expect(validatePolicies(resolved, withVisitors.policies, people)).toEqual([]);
    const { policies } = loadPolicies([
      {
        file: "policies/bad.cedar",
        text: [
          'permit (principal in Sanoma::Group::"finance", action, resource);',
          'permit (principal == Sanoma::Principal::"ada", action, resource);',
          '@hold("visitors") forbid (principal, action, resource);',
          '@hold("finance") permit (principal in Sanoma::Group::"visitors", action, resource);',
        ].join("\n"),
      },
    ]);
    expect(validatePolicies(resolved, policies, people).map((p) => [p.line, p.message])).toEqual([
      [1, expect.stringContaining("a permit is allowed only for visitors")],
      [2, expect.stringContaining("a permit is allowed only for visitors")],
      [3, '@hold("visitors") names no declared group or person, nor "on-behalf-of"'],
      [4, "a permit holds nothing: write the @hold on a forbid"],
    ]);
  });

  it("refuses a visitor's start and direct call no permit names, and anonymous's", () => {
    expect(policy.start(visitor, "refund", { amount: 1 })).toMatchObject({ kind: "deny" });
    expect(policy(asVisitor(saveCall("x", "open")))).toMatchObject({ kind: "deny" });
    expect(permitting.start(visitor, "refund", { amount: 1 })).toMatchObject({ kind: "allow" });
    expect(permitting.start(ANONYMOUS_PRINCIPAL, "refund", { amount: 1 })).toMatchObject({ kind: "deny" });
    expect(permitting(asVisitor(saveCall("x", "open"), ANONYMOUS_PRINCIPAL))).toMatchObject({ kind: "allow" });
    expect(permitting(asVisitor(saveCall("x", "open")))).toMatchObject({ kind: "deny" });
    // Told by its id, whatever groups it is given or not.
    expect(policy.start({ id: visitor.id, groups: ["finance"] }, "refund", { amount: 1 })).toMatchObject({
      kind: "deny",
    });
    expect(policy.start({ id: visitor.id }, "refund", { amount: 1 })).toMatchObject({ kind: "deny" });
    // People and agents are as they were.
    expect(permitting.start({ id: "bo" }, "refund", { amount: 1 })).toEqual({
      kind: "allow",
      reasons: ["allow-by-default"],
    });
  });

  it("allows a visitor's calls inside a run as anyone's, forbids still holding", () => {
    expect(policy(asVisitor(refundCall(100, "x")))).toMatchObject({ kind: "allow" });
    expect(policy(asVisitor(refundCall(2_000_000, "x")))).toMatchObject({
      kind: "approve",
      approver: { group: "finance" },
    });
    // Directly, no permit lets it in: refused, not held for anyone to let in.
    expect(policy(asVisitor({ ...refundCall(2_000_000, "x"), run: direct }))).toEqual({
      kind: "deny",
      reason: VISITOR_DENIED,
    });
  });

  it("previews a visitor's start and direct call as the permits say, a call in a run as allowed", () => {
    // Asked by id alone, as a visitor is told by its id.
    const inRun = (request: ReturnType<typeof ask>) => ({ ...request, inRun: true });
    expect(
      permitting
        .preview([
          ask(visitor.id, "workflow:refund"),
          ask("anonymous", "workflow:refund"),
          ask(visitor.id, "data.leads.save"),
          inRun(ask(visitor.id, "data.leads.save")),
          ask("anonymous", "data.leads.save"),
          ask(visitor.id, "shop.refunds.create"),
          inRun(ask(visitor.id, "shop.refunds.create")),
        ])
        .map((a) => a.answer),
    ).toEqual(["allow", "deny", "deny", "depends", "depends", "deny", "depends"]);
  });

  it("previews a visitor's start as depending on the input when its permit does", () => {
    const { policies } = loadPolicies([
      ...FILES,
      {
        file: "policies/visitors.cedar",
        text: 'permit (principal == Sanoma::Principal::"anonymous", action == Sanoma::Action::"workflow:refund", resource)\nwhen { context.input.amount < 100 };\n',
      },
    ]);
    const small = cedarPolicy(resolved, policies, people);
    expect(small.preview([ask("anonymous", "workflow:refund")])).toEqual([
      { answer: "depends", rule: { id: "policies/visitors.cedar#1", file: "policies/visitors.cedar" } },
    ]);
    expect(small.start(ANONYMOUS_PRINCIPAL, "refund", { amount: 50 })).toMatchObject({ kind: "allow" });
    expect(small.start(ANONYMOUS_PRINCIPAL, "refund", { amount: 500 })).toEqual({
      kind: "deny",
      reason: VISITOR_DENIED,
    });
  });

  it("is versioned by the permits too", () => {
    expect(permitting.version).not.toBe(policy.version);
    const other = loadPolicies([
      ...FILES,
      { ...VISITOR_FILE, text: VISITOR_FILE.text.replace('"workflow:refund"', '"data.leads.save"') },
    ]);
    expect(cedarPolicy(resolved, other.policies, people).version).not.toBe(permitting.version);
  });
});

describe("the policy on a run's start, who may decide its hold, and a save's record before", () => {
  const databaseUrl = testDatabaseUrl("cedar_mounts");
  const root = mkdtempSync(join(tmpdir(), "sanoma-cedar-mounts-"));
  mkdirSync(join(root, "resources"));
  writeFileSync(
    join(root, "resources", "people.ts"),
    `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
export const bo = sanoma.person({ id: "bo" });
export const cy = sanoma.person({ id: "cy" });
export const finance = sanoma.group({ name: "finance", members: [ada, bo] });
export const sales = sanoma.group({ name: "sales", members: [cy] });
`,
  );
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const payout = defineWorkflow({
    name: "payout",
    trigger: "manual",
    input: z.object({ amount: z.number().int() }),
    uses: [],
    run: async (ctx, { amount }) => ({ paid: amount, run: ctx.runId }),
  });
  const mark = defineWorkflow({
    name: "mark",
    trigger: "manual",
    // A default the callers leave out: the start is decided on the input as parsed, which has it.
    input: z.object({ key: z.string(), by: z.string().default("hand") }),
    uses: [leads.save],
    run: async (ctx, { key }) => ctx.data.leads.save({ record: { id: key, stage: "won" } }),
  });
  const files = [
    {
      file: "policies/payouts.cedar",
      text: `@id("payout-hold")
@hold("finance")
@title("Payouts need finance")
forbid (principal, action == Sanoma::Action::"workflow:payout", resource);

@id("mark-refused")
@reason("Nobody marks leads by hand")
forbid (principal, action == Sanoma::Action::"workflow:mark", resource)
when { context.input.key == "refused" };

@id("payout-sales")
@hold("sales")
@title("Big payouts need sales too")
forbid (principal, action == Sanoma::Action::"workflow:payout", resource)
when { context.input.amount > 100 };

@id("l20-finance")
@hold("finance")
forbid (principal, action == Sanoma::Action::"data.leads.save", resource == Sanoma::Target::"data:leads/l20");

@id("l20-ada")
@hold("ada")
forbid (principal, action == Sanoma::Action::"data.leads.save", resource == Sanoma::Target::"data:leads/l20");

@id("l11-kept")
@reason("That lead stays")
forbid (principal, action in Sanoma::Action::"effect:write", resource == Sanoma::Target::"data:leads/l11");
`,
    },
    FILES[1]!,
  ];
  mkdirSync(join(root, "policies"));
  for (const { file, text: body } of files) writeFileSync(join(root, file), body);
  // The policy is the root's Cedar files, as the runtime reads them.
  const app = useTestApp(
    { workflows: [payout, mark], collections: [leads], connectors: [], root, databaseUrl },
    { databaseUrl },
  );

  it("holds a start for finance before the body runs, until someone in finance approves", async () => {
    const runId = await app.client.start(payout, { amount: 5 }, { startedBy: "cy" });
    await waitFor(async () => (await app.client.run(runId))?.status === "waiting");
    const records = await app.client.ledger(runId);
    expect(records.map((r) => r.type)).toEqual(["run.started", "approval.requested"]);
    expect(records.filter((r) => r.type === "approval.requested")).toEqual([
      expect.objectContaining({
        approval: "approval-1",
        title: "Payouts need finance",
        approver: { group: "finance" },
        requestedBy: "policy",
        covers: ["workflow:payout"],
        op: "workflow:payout",
        reasons: ["payout-hold"],
      }),
    ]);
    expect(await app.client.decide(runId, { decision: "approve", by: { id: "bo" } })).toMatchObject({
      status: "approved",
      decidedBy: "bo",
      reasons: ["payout-hold"],
    });
    expect(await app.client.result(runId)).toEqual({ paid: 5, run: runId });
  });

  it("lifts each of a start's holds in turn, and a call's, before going on", async () => {
    const pending = async (runId: string, count: number) => {
      await waitFor(async () => (await app.client.approvals(runId)).length === count);
      return (await app.client.approvals(runId)).at(-1)!;
    };
    const big = await app.client.start(payout, { amount: 500 }, { startedBy: "ada" });
    expect(await pending(big, 1)).toMatchObject({ approver: { group: "finance" }, status: "pending" });
    await app.client.decide(big, { decision: "approve", by: { id: "bo" } });
    expect(await pending(big, 2)).toMatchObject({ title: "Big payouts need sales too", status: "pending" });
    await app.client.decide(big, { decision: "approve", by: { id: "cy" } });
    expect(await app.client.result(big)).toEqual({ paid: 500, run: big });

    const held = await app.client.start(mark, { key: "l20" }, { startedBy: "cy" });
    expect(await pending(held, 1)).toMatchObject({ approver: { group: "finance" }, reasons: ["l20-finance"] });
    await app.client.decide(held, { decision: "approve", by: { id: "bo" } });
    expect(await pending(held, 2)).toMatchObject({ approver: "ada", reasons: ["l20-ada"] });
    await app.client.decide(held, { decision: "approve", by: { id: "ada" } });
    expect(await app.client.result(held)).toMatchObject({ key: "l20" });
  });

  it("refuses a start the policy denies, and starts nothing", async () => {
    const runId = randomUUID();
    expect(await failure(app.client.start(mark, { key: "refused" }, { startedBy: "cy", runId }))).toMatchObject({
      code: "policy_denied",
      message: "workflow:mark was denied by policy: Nobody marks leads by hand",
    });
    expect(await app.client.run(runId)).toBeUndefined();
  });

  it("refuses the run's own actor as its decider, in the client and in the run", async () => {
    const runId = await app.client.start(payout, { amount: 7 }, { startedBy: "ada" });
    await waitFor(async () => (await app.client.run(runId))?.status === "waiting");
    expect(await failure(app.client.decide(runId, { decision: "approve", by: { id: "ada" } }))).toMatchObject({
      code: "not_approver",
      message: "own change (approval-1)",
      data: { reason: "own change" },
    });
    // Sent past the client, the run refuses it too, and says why in the ledger.
    await app.raw.send(runId, { decision: "approve", by: { id: "ada", groups: ["finance"] } }, "approval-1");
    await waitFor(async () => (await app.client.approvals(runId))[0]!.refused.length > 0);
    expect((await app.client.ledger(runId)).filter((r) => r.type === "approval.refused")).toEqual([
      expect.objectContaining({ by: "ada", reason: "own change" }),
    ]);
    expect(await app.client.decide(runId, { decision: "approve", by: { id: "bo" } })).toMatchObject({
      status: "approved",
    });
    expect(await app.client.result(runId)).toEqual({ paid: 7, run: runId });
  });

  it("gives the policy a saved record as it was, in a run or directly, so remarking a won lead is no change", async () => {
    await app.client.call("data.leads.save", { record: { id: "l1", stage: "won" } }, { actor: "cy" });
    const again = await app.client.start(mark, { key: "l1" }, { startedBy: "ada" });
    expect(await app.client.result(again)).toMatchObject({ key: "l1", record: { stage: "won" } });
    const fresh = await app.client.start(mark, { key: "l2" }, { startedBy: "ada" });
    expect(await failure(app.client.result(fresh))).toMatchObject({
      code: "policy_denied",
      message: "data.leads.save was denied by policy: Only sales may mark a lead won",
    });
    // A direct save, as the grid makes one, is given the record before too.
    const won = { record: { id: "l1", stage: "won" } };
    expect(await app.client.call("data.leads.save", won, { actor: "ada" })).toMatchObject({ key: "l1" });
    expect(
      await failure(app.client.call("data.leads.save", { record: { id: "l3", stage: "won" } }, { actor: "ada" })),
    ).toMatchObject({ code: "policy_denied" });
  });

  it("gives a record saved under fields since changed as it was: fixed and deleted, unless a policy reads what it lacks", async () => {
    // The collection as it was: no stage. The schema, which requires one, cannot hold such a record as `before`.
    const older = collection({ name: "leads", key: "id", fields: { id: "text" } });
    const client = await SanomaClient.connect({
      workflows: [],
      connectors: [],
      collections: [older],
      ledger: memoryLedger(),
      databaseUrl,
    });
    try {
      for (const id of ["l8", "l9", "l10", "l11"]) {
        await client.call("data.leads.save", { record: { id } }, { actor: "ada" });
      }
    } finally {
      await client.close();
    }
    const fixed = { record: { id: "l9", stage: "open" } };
    expect(await app.client.call("data.leads.save", fixed, { actor: "ada" })).toMatchObject({ key: "l9" });
    await app.client.call("data.leads.delete", { key: "l8" }, { actor: "ada" });
    expect(await app.client.call("data.leads.get", { key: "l8" }, { actor: "ada" })).toBeNull();
    // Marking it won asks leads-won for its stage before, which it lacks: denied, not let through.
    const won = { record: { id: "l10", stage: "won" } };
    expect(await failure(app.client.call("data.leads.save", won, { actor: "ada" }))).toMatchObject({
      code: "policy_denied",
      message: expect.stringMatching(/^data\.leads\.save was denied by policy: leads-won failed: /),
    });
    // A policy on the action's group still holds for such a record.
    expect(await failure(app.client.call("data.leads.delete", { key: "l11" }, { actor: "ada" }))).toMatchObject({
      code: "policy_denied",
      message: "data.leads.delete was denied by policy: That lead stays",
    });
  });
});

/** The config, with its root here. */
const at = (root: string) => ({ ...config, root });

describe("the root's policy, as resolveConfig reads it", () => {
  const peopleFile = `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
export const bo = sanoma.person({ id: "bo" });
export const finance = sanoma.group({ name: "finance", members: [ada] });
`;

  it("is the root's policies/**/*.cedar, which describeConfig says it has, with their version", async () => {
    const root = rootWith({ "resources/people.ts": peopleFile, [FILES[0]!.file]: FILES[0]!.text });
    const { policy: cedar, policyProblems } = resolveConfig(at(root));
    expect(policyProblems).toEqual([]);
    expect(cedar.version).toMatch(/^[0-9a-f]{12}$/);
    expect(await cedar(refundCall(2_000_000, "bo"))).toMatchObject({ kind: "approve", approver: { group: "finance" } });
    expect(describeConfig(at(root)).policy).toEqual({ defined: true, version: cedar.version });
  });

  it("is allowAll for a root with no policies, which describeConfig says it has not", () => {
    const root = rootWith({ "resources/people.ts": peopleFile });
    expect(resolveConfig(at(root))).toMatchObject({ policy: allowAll, policyProblems: [] });
    expect(describeConfig(at(root)).policy).toEqual({ defined: false });
  });

  it("refuses every call, start and preview while the policies have a problem, naming the first", async () => {
    const root = rootWith({
      "resources/people.ts": peopleFile,
      "policies/money.cedar": `@id("typo")
forbid (principal, action == Sanoma::Action::"shop.refunds.create", resource)
when { context.input.amont > 5 };
`,
    });
    const { policy: refusing, policyProblems } = resolveConfig(at(root));
    expect(policyProblems).toEqual([expect.stringMatching(/^policies\/money\.cedar:3:\d+: typo: .*amont/)]);
    const reason = `The policies do not hold: ${policyProblems[0]}`;
    expect(await refusing(refundCall(5, "ada"))).toEqual({ kind: "deny", reason });
    expect(refusing.start({ id: "ada" }, "refund", { amount: 5 })).toEqual({ kind: "deny", reason });
    expect(refusing.preview([ask("ada", "shop.refunds.create")])).toEqual([{ answer: "deny" }]);
    expect(describeConfig(at(root)).policy).toEqual({ defined: true, problems: policyProblems });
    // A worker on it starts, and says why it refuses everything.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await (await startWorker({ ...at(root), databaseUrl: testDatabaseUrl("cedar_refusing") })).stop();
      expect(warn.mock.calls.flat().join("\n")).toContain(
        `the policies do not hold, so every call and start is refused:\n  ${policyProblems[0]}`,
      );
    } finally {
      warn.mockRestore();
    }
  });
});
