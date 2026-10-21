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
import type { ApprovalState } from "../src/define.ts";
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
} from "../src/index.ts";
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
  it("has the declared groups and agents, every operation in its effect's group and every workflow in start", () => {
    expect(text).toContain('entity Group enum ["agents", "finance", "sales"];');
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
      expect.objectContaining({ line: 6, message: expect.stringContaining("a permit changes nothing") }),
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
    expect(
      await decideCall(policy, shop.refunds.create, { amount: 2_000_000, customer: "c" }, { id: "bo" }, run()),
    ).toEqual({
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
      for (const id of ["l8", "l9", "l10"]) {
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
    expect(describeConfig(at(root)).policy).toEqual({ defined: true });
    // A worker on it starts, and says why it refuses everything.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await (await startWorker({ ...at(root), databaseUrl: testDatabaseUrl("cedar_mounts") })).stop();
      expect(warn.mock.calls.flat().join("\n")).toContain(
        `the policies do not hold, so every call and start is refused:\n  ${policyProblems[0]}`,
      );
    } finally {
      warn.mockRestore();
    }
  });
});
