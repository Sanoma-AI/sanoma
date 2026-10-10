import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bluesky } from "@sanoma/connector-bluesky";
import { testDatabaseUrl } from "@sanoma/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { describeConfig } from "../src/describe.ts";
import {
  allow,
  allowAll,
  defineConnector,
  defineDriver,
  definePolicy,
  defineResource,
  defineWorkflow,
  deny,
  DRIFT_WORKFLOW,
  type DriftReport,
  errorCode,
  type LedgerRecord,
  memoryLedger,
  type PolicyCall,
  resolveConfig,
  SanomaClient,
} from "../src/index.ts";
import { companyFakes, nodeIdOf } from "./fixtures/company/fakes.ts";
import company from "./fixtures/company/sanoma.config.ts";
import { marketingFakes, useApp } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. The company fixture's data files, checked against the GitHub
// and Stripe fakes, which hold an object for each declared resource as the vendor would.
const databaseUrl = testDatabaseUrl("drift");
const alice = { id: "alice" };

const { github, stripe, drivers, declared, seed } = companyFakes();

const policyCalls: PolicyCall[] = [];
// Refuses Stripe products to "no-stripe", so one resource fails and the run goes on.
const policy = definePolicy((call) => {
  policyCalls.push(call);
  return call.actor.id === "no-stripe" && call.op.id === "stripe.product.import" ? deny("no Stripe") : allow();
});
const companyConfig = { workflows: [], connectors: company.connectors, file: company.file!, drivers, policy };

const byId = (report: DriftReport) => Object.fromEntries(report.resources.map((r) => [r.id, r]));
const opCalls = (records: LedgerRecord[]) => records.filter((r) => r.type === "op.called");

describe("the drift workflow", () => {
  const app = useApp(databaseUrl, "drift", () => companyConfig);

  beforeEach(() => {
    seed();
    policyCalls.length = 0;
  });

  async function drift(startedBy = alice) {
    const runId = await app.client.drift({ startedBy });
    return { runId, report: await app.client.driftReport(runId) };
  }

  it("reports every declared resource clean when the vendors hold what is declared", async () => {
    // The vendor reorders a set and sets a field nobody declared: neither is drift. And GitHub
    // holds each rule's repository by its node id, which stands for the repository's name.
    github.override("repository", "website", { topics: ["astro", "website"] });
    github.override("repository", "docs", { delete_branch_on_merge: true });
    const { report } = await drift();
    expect(report.resources.map((r) => [r.id, r.vendor, r.type, r.name, r.status])).toEqual(
      declared.map((r) => [r.id, r.vendor, r.type, r.name, "clean"]),
    );
    expect(report.resources.every((r) => r.fields.length === 0)).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.startedAt).toBeLessThanOrEqual(report.finishedAt);
  });

  it("reports one GitHub field and one Stripe field that changed, and a rule gone; the rest are clean", async () => {
    github.override("repository", "website", { has_wiki: true });
    stripe.override("product", "prod_SanomaFixturePro", { name: "Sanoma Professional" });
    // GitHub answers an import of a rule that is not there as its provider does: failed_precondition.
    github.remove("branch_protection", "docs:main");
    const { runId, report } = await drift();

    expect(report.resources.filter((r) => r.status === "drifted")).toEqual([
      {
        id: "resources/billing/stripe.ts#pro",
        vendor: "stripe",
        type: "product",
        name: "prod_SanomaFixturePro",
        status: "drifted",
        fields: [{ path: "name", desired: "Sanoma Pro", actual: "Sanoma Professional" }],
      },
      {
        id: "resources/identity/github.ts#website",
        vendor: "github",
        type: "repository",
        name: "website",
        status: "drifted",
        fields: [{ path: "has_wiki", desired: false, actual: true }],
      },
    ]);
    expect(byId(report)["resources/identity/rules.ts#docsMain"]).toMatchObject({ status: "gone", fields: [] });
    expect(report.resources.filter((r) => r.status === "clean").map((r) => r.id)).toEqual([
      "resources/billing/stripe.ts#events",
      "resources/identity/github.ts#docs",
      "resources/identity/github.ts#websiteMain",
    ]);

    // One vendor call per resource, through ctx: the policy saw each as a read, and the ledger has it.
    const records = await app.client.ledger(runId);
    const calls = opCalls(records);
    const expected = declared.map((r) => [`${r.vendor}.${r.type}.import`, r.name]);
    expect(calls.map((r) => r.type === "op.called" && [r.op, (r.input as { id: string }).id])).toEqual(expected);
    expect(calls.every((r) => r.type === "op.called" && r.effect === "read" && r.decision.kind === "allow")).toBe(true);
    expect(policyCalls.map((c) => [c.op.id, c.effect, c.target])).toEqual(expected.map(([op, id]) => [op, "read", id]));
    // The gone rule's import answered gone, and the driver's handle is recorded by name only.
    expect(calls.find((r) => r.type === "op.called" && (r.input as { id: string }).id === "docs:main")).toMatchObject({
      output: { id: "docs:main", gone: true },
    });
    expect(calls[0]).toMatchObject({ output: { gone: false, handle: "<handle>" } });
    expect(JSON.stringify(records)).not.toMatch(/"handle":"\d+:/);
    // The run's record: no input (it read the data files itself), and its report.
    expect(records[0]).toMatchObject({ type: "run.started", input: {} });
    expect(records.at(-1)).toMatchObject({ type: "run.finished", output: report });
  });

  it("compares a reference by any of the identities its resource holds, read in the same run", async () => {
    // The rule now guards another repository, by that one's node id: drift, named by name and as held.
    github.override("branch_protection", "website:main", { repository_id: nodeIdOf("docs") });
    const { report } = await drift();
    expect(byId(report)["resources/identity/github.ts#websiteMain"]).toMatchObject({
      status: "drifted",
      fields: [{ path: "repository_id", desired: "website", actual: nodeIdOf("docs") }],
    });
    // The name, which the import id holds too, is the same repository.
    github.override("branch_protection", "website:main", { repository_id: "website" });
    expect(byId((await drift()).report)["resources/identity/github.ts#websiteMain"]).toMatchObject({ status: "clean" });
  });

  it("names a changed field inside a list by its path, with the item's index", async () => {
    github.override("branch_protection", "website:main", {
      required_pull_request_reviews: [{ required_approving_review_count: 2, dismiss_stale_reviews: true }],
    });
    const { report } = await drift();
    expect(byId(report)["resources/identity/github.ts#websiteMain"]).toMatchObject({
      status: "drifted",
      fields: [{ path: "required_pull_request_reviews.0.required_approving_review_count", desired: 1, actual: 2 }],
    });
  });

  it("reports a resource it could not read, with why, and goes on to the rest", async () => {
    const { runId, report } = await drift({ id: "no-stripe" });
    expect(byId(report)["resources/billing/stripe.ts#pro"]).toMatchObject({
      status: "error",
      fields: [],
      error: expect.stringMatching(/denied by policy: no Stripe/),
    });
    expect(report.resources.filter((r) => r.status === "clean")).toHaveLength(declared.length - 1);
    expect((await app.client.run(runId))?.status).toBe("finished");
  });

  it("refuses any input: the run reads the data files itself", async () => {
    const definition = resolveConfig(app.config).workflows.find((wf) => wf.name === DRIFT_WORKFLOW)!;
    const forged = { resources: [{ id: "x#y", vendor: "github", type: "repository", name: "x", desired: {} }] };
    const err = await app.client.start(definition, forged as never, { startedBy: alice }).catch((e: unknown) => e);
    expect(errorCode(err)).toBe("invalid_input");
  });

  it("runs on a worker started again, which takes its definition by name", async () => {
    await app.restart();
    const { report } = await drift();
    expect(report.resources.every((r) => r.status === "clean")).toBe(true);
  });

  it("lists drift runs by workflow, and refuses a report of a run that is none", async () => {
    const { runId } = await drift();
    const runs = await app.client.runs({ workflow: DRIFT_WORKFLOW, limit: 1 });
    expect(runs.map((r) => [r.runId, r.workflow, r.status])).toEqual([[runId, DRIFT_WORKFLOW, "finished"]]);
    expect(await app.client.runs({ workflow: "announce" })).toEqual([]);
    expect(errorCode(await app.client.driftReport("no-such-run").catch((e: unknown) => e))).toBe("run_not_found");
  });
});

describe("a drift run's record of the data files", () => {
  // A vendor whose hooks take a write-only `token`, declared in a data file and never read back.
  const hook = defineResource({
    vendor: "acme",
    type: "hook",
    title: "Hook",
    identity: "name",
    schema: z.object({ name: z.string(), url: z.string().nullish(), token: z.string().nullish() }),
    fields: { immutable: [], vendorOwned: [], writeOnly: ["token"] },
    find: ({ name }) => name,
  });
  const acme = defineConnector("acme", { hook }, { title: "Acme", package: "@acme/connector" });
  const acmeDriver = defineDriver(acme, {
    hook: {
      import: async ({ id }) => ({ id, gone: false, state: { name: id, url: "https://example.com/moved" } }),
      read: async ({ id }) => ({ id, gone: true }),
    },
  });
  const root = mkdtempSync(join(tmpdir(), "sanoma-drift-secret-"));
  mkdirSync(join(root, "resources"));
  const secret = "secret-the-run-never-records";
  writeFileSync(
    join(root, "resources", "hooks.ts"),
    `import { acme } from "@acme/connector/resources";\n\n` +
      `export const hook = acme.hook({ name: "deploys", url: "https://example.com/hook", token: "${secret}" });\n\n` +
      `export default [hook];\n`,
  );
  const app = useApp(databaseUrl, "drift-secret", () => ({
    workflows: [],
    connectors: [acme],
    drivers: [acmeDriver],
    root,
  }));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("leaves out write-only values, and never compares them", async () => {
    const runId = await app.client.drift({ startedBy: alice });
    const report = await app.client.driftReport(runId);
    expect(report.problems).toEqual([]);
    expect(report.resources).toEqual([
      {
        id: "resources/hooks.ts#hook",
        vendor: "acme",
        type: "hook",
        name: "deploys",
        status: "drifted",
        fields: [{ path: "url", desired: "https://example.com/hook", actual: "https://example.com/moved" }],
      },
    ]);
    const steps = await app.raw.listWorkflowSteps(runId);
    expect(steps?.find((step) => step.name === "drift:data-files")?.output).toMatchObject({
      resources: [{ id: "resources/hooks.ts#hook", desired: { name: "deploys", url: "https://example.com/hook" } }],
    });
    expect(JSON.stringify(steps)).not.toContain(secret);
    expect(JSON.stringify(await app.client.ledger(runId))).not.toContain(secret);
  });
});

describe("SanomaClient's drift", () => {
  it("refuses to start on a config whose connectors declare no resource types", async () => {
    const marketing = await SanomaClient.connect({
      workflows: [],
      connectors: [bluesky],
      drivers: marketingFakes().drivers.filter((d) => d.vendor === "bluesky"),
      policy: allowAll,
      ledger: memoryLedger(),
      appName: "drift-none",
      databaseUrl,
    });
    try {
      const err = await marketing.drift({ startedBy: alice }).catch((e: unknown) => e);
      expect(errorCode(err)).toBe("invalid_input");
      expect((err as Error).message).toMatch(/declare no resource types/);
    } finally {
      await marketing.close();
    }
  });
});

describe("the built-in drift workflow in a config", () => {
  const config = { ...company, drivers };

  it("is added when the connectors declare resource types, using each type's import that has a driver", () => {
    expect(resolveConfig(config).workflows.map((wf) => wf.name)).toEqual([DRIFT_WORKFLOW]);
    const entry = describeConfig(config).workflows.find((wf) => wf.name === DRIFT_WORKFLOW);
    expect(entry).toMatchObject({ name: "drift", title: "Check resources for drift", builtin: true });
    expect(entry?.ops).toEqual([
      "github.branch_protection.import",
      "github.repository.import",
      "github.team_membership.import",
      "stripe.product.import",
      "stripe.webhook_endpoint.import",
    ]);
    expect(entry?.input).toMatchObject({ type: "object", additionalProperties: false });
    expect(entry?.outline).toMatchObject({ file: expect.stringMatching(/src\/drift\.ts$/) });
    // Without drivers it is there all the same, and uses nothing: each resource reports the missing driver.
    expect(describeConfig(company).workflows).toMatchObject([{ name: "drift", builtin: true, ops: [] }]);
  });

  it("is not added when no connector declares a resource type, and the config's own workflows are not built-in", () => {
    const marketing = { ...company, connectors: [bluesky], drivers: [] };
    expect(resolveConfig(marketing).workflows).toEqual([]);
    const own = defineWorkflow({ name: "own", trigger: "manual", input: z.object({}), uses: [], run: async () => 1 });
    expect(
      describeConfig({ ...company, workflows: [own] }).workflows.find((wf) => wf.name === "own"),
    ).not.toHaveProperty("builtin");
  });

  it("refuses a config workflow named drift", () => {
    const named = defineWorkflow({
      name: "drift",
      trigger: "manual",
      input: z.object({}),
      uses: [],
      run: async () => 1,
    });
    expect(() => resolveConfig({ ...company, workflows: [named] })).toThrow(/built-in drift workflow/);
  });

  it("changes the app's version with the operations it uses", () => {
    expect(resolveConfig(config).version).not.toBe(resolveConfig(company).version);
  });
});
