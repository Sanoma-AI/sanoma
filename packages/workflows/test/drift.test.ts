import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bluesky } from "@sanoma-ai/connector-bluesky";
import { testDatabaseUrl, withFake } from "@sanoma-ai/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { describeConfig, writeLockfile } from "../src/describe.ts";
import {
  APPLY_WORKFLOW,
  CHANGE_WORKFLOW,
  defineConnector,
  defineResource,
  defineWorkflow,
  DRIFT_WORKFLOW,
  type DriftReport,
  errorCode,
  type LedgerRecord,
  memoryLedger,
  resolveConfig,
  SanomaClient,
} from "../src/index.ts";
import { defineFake } from "../src/fake.ts";
import { companyConfig, companyDir, companyFakes, nodeIdOf } from "./fixtures/company/fakes.ts";
import company from "./fixtures/company/sanoma.config.ts";
import { CALL_WORKFLOW, visitorPrincipal } from "../src/shared.ts";
import { rootWith, useApp, withoutSetup } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. The company fixture's data files, checked against the GitHub
// and Stripe fakes, which hold an object for each declared resource as the vendor would.
const databaseUrl = testDatabaseUrl("drift");
const alice = { id: "alice" };

const fakes = companyFakes();
const { github, stripe, declared, seed } = fakes;

// The company's data files, with a policy that refuses Stripe products to "no-stripe", so one
// resource fails and the run goes on.
const policyRoot = rootWith(
  {
    "policies/policy.cedar": `@reason("no Stripe")
forbid (principal == Sanoma::Principal::"no-stripe", action == Sanoma::Action::"stripe.product.import", resource);
`,
  },
  companyDir,
);
// The company's own fakes replace useApp's, the marketing vendors', whose connectors this config replaces.
const companyOnFakes = companyConfig([], fakes, policyRoot);

const byId = (report: DriftReport) => Object.fromEntries(report.resources.map((r) => [r.id, r]));
/** What a check of a resource the vendor holds as declared says: clean when it is bound, else absent. */
const asDeclared = (r: { binding?: string }) => (r.binding === undefined ? "absent" : "clean");
const opCalls = (records: LedgerRecord[]) => records.filter((r) => r.type === "op.called");

describe("the drift workflow", () => {
  const app = useApp("drift", () => companyOnFakes);

  beforeEach(() => {
    seed();
  });

  async function drift(startedBy = alice) {
    const runId = await app.client.drift({ startedBy });
    return { runId, report: await app.client.driftReport(runId) };
  }

  it("is no visitor's to start", async () => {
    const err = await app.client.drift({ startedBy: visitorPrincipal("auth0", "u1") }).catch((e: unknown) => e);
    expect(errorCode(err)).toBe("policy_denied");
  });

  it("reports every bound resource clean when the vendors hold what is declared, and the rest absent", async () => {
    // The vendor reorders a set and sets a field nobody declared: neither is drift. And GitHub
    // holds each rule's repository by its node id, which stands for the repository's name.
    github.override("repository", "website", { topics: ["astro", "website"] });
    github.override("repository", "docs", { delete_branch_on_merge: true });
    const { report } = await drift();
    expect(report.resources.map((r) => [r.id, r.vendor, r.type, r.name, r.binding, r.status])).toEqual(
      declared.map((r) => [r.id, r.vendor, r.type, r.name, r.binding, asDeclared(r)]),
    );
    // Unbound: the rule GitHub finds by its identity, with its binding id for apply to bind; the
    // webhook endpoint has no identity, so nothing finds it.
    expect(byId(report)["resources/identity/rules.ts#docsMain"]).toMatchObject({
      status: "absent",
      found: "BPR_docs:main",
    });
    expect(byId(report)["resources/billing/stripe.ts#events"]).not.toHaveProperty("found");
    expect(report.resources.every((r) => r.fields.length === 0)).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.startedAt).toBeLessThanOrEqual(report.finishedAt);
  });

  it("reports one GitHub field and one Stripe field that changed, and a rule gone; the rest are clean or absent", async () => {
    github.override("repository", "website", { has_wiki: true });
    stripe.override("product", "prod_SanomaFixturePro", { name: "Sanoma Professional" });
    // GitHub answers an import of a rule that is not there as its provider does: failed_precondition.
    github.remove("branch_protection", "website:main");
    const { runId, report } = await drift();

    expect(report.resources.filter((r) => r.status === "drifted")).toEqual([
      {
        id: "resources/billing/stripe.ts#pro",
        vendor: "stripe",
        type: "product",
        name: "pro",
        binding: "prod_SanomaFixturePro",
        status: "drifted",
        fields: [{ path: "name", desired: "Sanoma Pro", actual: "Sanoma Professional" }],
      },
      {
        id: "resources/identity/github.ts#website",
        vendor: "github",
        type: "repository",
        name: "website",
        binding: "R_website",
        status: "drifted",
        fields: [{ path: "has_wiki", desired: false, actual: true }],
      },
    ]);
    expect(byId(report)["resources/identity/github.ts#websiteMain"]).toMatchObject({ status: "gone", fields: [] });
    expect(report.resources.filter((r) => r.status === "clean").map((r) => r.id)).toEqual([
      "resources/identity/github.ts#docs",
    ]);
    expect(report.resources.filter((r) => r.status === "absent").map((r) => r.id)).toEqual([
      "resources/billing/stripe.ts#events",
      "resources/identity/rules.ts#docsMain",
    ]);

    // One vendor call per resource bound or with an identity, by its binding else its identity,
    // through ctx: the policy allowed each as a read, by its default, and the ledger has it.
    const records = await app.client.ledger(runId);
    const calls = opCalls(records);
    const expected = declared.flatMap((r) => {
      const id = r.binding ?? r.identity;
      return id === undefined ? [] : [[`${r.vendor}.${r.type}.import`, id]];
    });
    expect(expected).toHaveLength(declared.length - 1);
    expect(calls.map((r) => r.type === "op.called" && [r.op, (r.input as { id: string }).id])).toEqual(expected);
    expect(calls.map((r) => r.type === "op.called" && [r.effect, r.decision])).toEqual(
      expected.map(() => ["read", { kind: "allow", reasons: ["allow-by-default"], policyVersion: expect.any(String) }]),
    );
    // The gone rule's import answered gone, and the driver's handle is recorded by name only.
    expect(
      calls.find((r) => r.type === "op.called" && (r.input as { id: string }).id === "BPR_website:main"),
    ).toMatchObject({ output: { id: "BPR_website:main", gone: true } });
    expect(calls[0]).toMatchObject({ output: { gone: false, handle: "<handle>" } });
    expect(JSON.stringify(records)).not.toMatch(/"handle":"\d+:/);
    // The run's record: no input (it read the data files itself), and its report.
    expect(records[0]).toMatchObject({ type: "run.started", input: {} });
    expect(records.at(-1)).toMatchObject({ type: "run.finished", output: report });
  });

  it("reports an unbound resource absent, without `found`, when its identity finds nothing either", async () => {
    github.remove("branch_protection", "docs:main");
    const { report } = await drift();
    const docsMain = byId(report)["resources/identity/rules.ts#docsMain"];
    expect(docsMain).toMatchObject({ status: "absent", fields: [] });
    expect(docsMain).not.toHaveProperty("found");
    expect(docsMain).not.toHaveProperty("binding");
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
    expect(report.resources.filter((r) => r.status === "clean").map((r) => r.id)).toEqual([
      "resources/identity/github.ts#website",
      "resources/identity/github.ts#docs",
      "resources/identity/github.ts#websiteMain",
    ]);
    expect((await app.client.run(runId))?.status).toBe("finished");
  });

  it("refuses any input: the run reads the data files itself", async () => {
    const definition = resolveConfig(app.config).workflows.get(DRIFT_WORKFLOW)!;
    const forged = { resources: [{ id: "x#y", vendor: "github", type: "repository", name: "x", desired: {} }] };
    const err = await app.client.start(definition, forged as never, { startedBy: alice }).catch((e: unknown) => e);
    expect(errorCode(err)).toBe("invalid_input");
  });

  it("runs on a worker started again, which takes its definition by name", async () => {
    await app.restart();
    const { report } = await drift();
    expect(report.resources.every((r) => r.status === asDeclared(r))).toBe(true);
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
  // Its fake, which live runs call: the hook moved.
  const acmeFake = defineFake(acme, {
    initial: () => ({}),
    ops: () => ({
      hook: {
        import: async ({ id }) => ({ id, gone: false, state: { name: id, url: "https://example.com/moved" } }),
        read: async ({ id }) => ({ id, gone: true }),
      },
    }),
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
  writeLockfile(root, { "resources/hooks.ts#hook": { type: "acme.hook", id: "deploys" } });
  const app = useApp("drift-secret", () => ({
    workflows: [],
    connectors: [withFake(acme, acmeFake)],
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
        binding: "deploys",
        status: "drifted",
        fields: [{ path: "url", desired: "https://example.com/hook", actual: "https://example.com/moved" }],
      },
    ]);
    const steps = await app.raw.listWorkflowSteps(runId);
    expect(steps?.find((step) => step.name === "drift:data-files")?.output).toMatchObject({
      resources: [
        {
          id: "resources/hooks.ts#hook",
          identity: "deploys",
          binding: "deploys",
          desired: { name: "deploys", url: "https://example.com/hook" },
        },
      ],
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
      ledger: memoryLedger(),
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
  const config = { ...company, connectors: fakes.connectors };
  // The company's connectors with nothing attached: no drivers.
  const bare = { ...company, connectors: company.connectors.map(withoutSetup) };

  it("is added, with apply, when the connectors declare resource types, using each type's import that has a driver", () => {
    // Beside change and call, built in every config (call for the listing of apps).
    expect([...resolveConfig(config).workflows.keys()]).toEqual([
      DRIFT_WORKFLOW,
      APPLY_WORKFLOW,
      CHANGE_WORKFLOW,
      CALL_WORKFLOW,
    ]);
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
    // Apply uses the imports too, and each writable type's change operations.
    const apply = describeConfig(config).workflows.find((wf) => wf.name === APPLY_WORKFLOW);
    expect(apply).toMatchObject({ title: "Apply resources", builtin: true, builtins: ["approval"], problems: [] });
    expect(apply?.ops).toEqual([
      ...entry!.ops,
      "github.repository.create",
      "github.repository.delete",
      "github.repository.plan",
      "github.repository.update",
    ]);
    // Without drivers they are there all the same, and use nothing: each resource reports the missing driver.
    expect(describeConfig(bare).workflows).toMatchObject([
      { name: "apply", builtin: true, ops: [] },
      { name: "call", builtin: true, ops: ["sanoma.apps.list"] },
      { name: "change", builtin: true },
      { name: "drift", builtin: true, ops: [] },
    ]);
  });

  it("is not added when no connector declares a resource type, and the config's own workflows are not built-in", () => {
    const marketing = { ...company, connectors: [bluesky] };
    // Only the change workflow and call (for the listing of apps), which every config has.
    expect([...resolveConfig(marketing).workflows.keys()]).toEqual([CHANGE_WORKFLOW, CALL_WORKFLOW]);
    const own = defineWorkflow({ name: "own", trigger: "manual", input: z.object({}), uses: [], run: async () => 1 });
    expect(
      describeConfig({ ...company, workflows: [own] }).workflows.find((wf) => wf.name === "own"),
    ).not.toHaveProperty("builtin");
  });

  it.each(["drift", "apply", "change"])("refuses a config workflow named %s, a built-in's name", (name) => {
    const named = defineWorkflow({ name, trigger: "manual", input: z.object({}), uses: [], run: async () => 1 });
    expect(() => resolveConfig({ ...company, workflows: [named] })).toThrow(
      `A workflow is named "${name}", the name of a built-in workflow`,
    );
  });

  it("changes the app's version with the operations it uses", () => {
    expect(resolveConfig(config).version).not.toBe(resolveConfig(bare).version);
  });
});
