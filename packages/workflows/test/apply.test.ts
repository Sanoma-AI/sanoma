import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tfConnector } from "@sanoma-ai/bridge/connector";
import { type BridgeState, stateBridge } from "@sanoma-ai/bridge/fake";
import { github } from "@sanoma-ai/connector-github";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { LOCKFILE, readLockfile, serializeLockfile, writeLockfile } from "../src/describe.ts";
import {
  allow,
  approve,
  approvedFor,
  type ApplyInput,
  type ApplyReport,
  definePolicy,
  defineWorkflow,
  type LedgerRecord,
  memoryLedger,
  type PlanStep,
  type Principal,
  resolveConfig,
  type Source,
  withSetup,
} from "../src/index.ts";
import { companyFakes } from "./fixtures/company/fakes.ts";
import company from "./fixtures/company/sanoma.config.ts";
import { pending, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. Apply on a copy of a company's data files and lockfile (so the
// fixture's stay as they are), against fakes: the company's GitHub and Stripe, and Acme, a
// vendor made here over a `stateBridge` whose sites are replaced when their region changes.
const alice = { id: "alice" };
// The policy holds every change of hers for the lead, once per run, as a team would.
const careful = { id: "careful" };
const policy = definePolicy((call) =>
  call.actor.id === careful.id && call.effect === "write" && !approvedFor(call.run.approvals, call.op.id, "lead")
    ? approve("lead")
    : allow(),
);

/** A source that records its commits, in a directory of its own. */
function recordingSource(root: string) {
  const commits: { paths: string[]; message: string; author: string }[] = [];
  const source: Source = {
    root,
    commit: (change) => {
      commits.push(change);
      return { revision: `rev${commits.length}` };
    },
    head: () => `rev${commits.length}`,
  };
  return { source, commits };
}

const ops = (records: LedgerRecord[]) =>
  records.flatMap((r) => (r.type === "op.called" && !r.error ? [[r.op, r.input] as const] : []));
const actions = (report: ApplyReport) => report.plan.steps.map((s) => [s.id.replace(/^resources\//, ""), s.action]);
const resultOf = (report: ApplyReport, id: string) => report.results.find((r) => r.id === id);

describe("the apply workflow on the company's resources", () => {
  const root = mkdtempSync(join(tmpdir(), "sanoma-apply-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const fakes = companyFakes();
  const { source, commits } = recordingSource(root);
  const app = useTestApp(
    { workflows: [], connectors: fakes.connectors, policy, ledger: memoryLedger(), root },
    { databaseUrl: testDatabaseUrl("apply"), source },
  );

  const id = {
    blog: "resources/identity/blog.ts#blog",
    website: "resources/identity/github.ts#website",
    docs: "resources/identity/github.ts#docs",
    docsMain: "resources/identity/rules.ts#docsMain",
    basic: "resources/billing/stripe.ts#basic",
    old: "resources/identity/old.ts#old",
  };
  // The fixture's data files and lockfile, and a repository nobody has made yet.
  beforeEach(() => {
    rmSync(join(root, "resources"), { recursive: true, force: true });
    cpSync(join(dirname(company.file!), "resources"), join(root, "resources"), { recursive: true });
    writeFileSync(
      join(root, "resources/identity/blog.ts"),
      `import { github } from "@sanoma-ai/connector-github/resources";\n\n` +
        `export const blog = github.repository({ name: "blog", visibility: "private" });\n\nexport default [blog];\n`,
    );
    fakes.seed();
    commits.length = 0;
  });

  async function apply(input: ApplyInput = {}, startedBy: Principal = alice) {
    const runId = await app.client.apply(input, { startedBy });
    return { runId, report: await app.client.applyReport(runId) };
  }

  it("binds what an identity finds, creates what nothing finds, and leaves what is as declared", async () => {
    const { runId, report } = await apply();
    expect(actions(report)).toEqual([
      ["billing/stripe.ts#pro", "none"],
      ["identity/blog.ts#blog", "create"],
      ["identity/github.ts#website", "none"],
      ["identity/github.ts#docs", "none"],
      ["identity/github.ts#websiteMain", "none"],
      ["identity/rules.ts#docsMain", "bind"],
      // Orphaned in the fixture's lockfile: asked about, never touched unanswered.
      ["billing/stripe.ts#basic", "orphan"],
    ]);
    // Stripe's webhook endpoints are read-only: nothing finds this one, and apply cannot make it.
    expect(report.plan.problems).toEqual([
      {
        file: "resources/billing/stripe.ts",
        message: "events: apply cannot create it: a stripe.webhook_endpoint is read-only",
      },
    ]);
    const create = report.plan.steps.find((s) => s.id === id.blog) as Extract<PlanStep, { action: "create" }>;
    expect(create.planned).toMatchObject({ name: "blog", visibility: "private", node_id: null });
    expect(create.unknown).toContain("node_id");
    expect(report.plan.steps.find((s) => s.id === id.docsMain)).toMatchObject({
      binding: "BPR_docs:main",
      source: "found",
    });

    const blog = resultOf(report, id.blog)!;
    expect(blog).toMatchObject({ action: "create", status: "done", binding: expect.stringMatching(/^node_id-\d+$/) });
    expect(resultOf(report, id.docsMain)).toEqual({
      id: id.docsMain,
      action: "bind",
      status: "done",
      binding: "BPR_docs:main",
    });
    expect(resultOf(report, id.basic)).toMatchObject({ status: "skipped", binding: "prod_SanomaFixtureBasic" });

    // The lockfile on disk is the one the run ended with, committed once per change, by who ran it.
    expect(readLockfile(root)).toEqual({ bindings: report.lockfile.bindings, problems: [] });
    expect(readFileSync(join(root, LOCKFILE), "utf8")).toBe(serializeLockfile(report.lockfile.bindings));
    expect(report.lockfile.bindings[id.blog]).toEqual({ type: "github.repository", id: blog.binding });
    expect(report.lockfile.bindings[id.basic]).toBeDefined();
    expect(report.lockfile).toMatchObject({ written: true, revision: "rev2" });
    expect(commits).toEqual([
      { paths: [LOCKFILE], message: `Apply: create ${id.blog} (github.repository ${blog.binding})`, author: "alice" },
      {
        paths: [LOCKFILE],
        message: `Apply: bind ${id.docsMain} (github.branch_protection BPR_docs:main)`,
        author: "alice",
      },
    ]);

    // One change call, through the policy, with no approval asked: this policy holds nothing of alice's.
    const records = await app.client.ledger(runId);
    expect(ops(records).filter(([op]) => !op.endsWith(".import") && !op.endsWith(".plan"))).toEqual([
      ["github.repository.create", { desired: { name: "blog", visibility: "private" } }],
    ]);
    expect(records.some((r) => r.type === "approval.requested")).toBe(false);
    // The binding is written in the step right after the create, before anything else is called.
    const steps = (await app.raw.listWorkflowSteps(runId))!.map((s) => s.name);
    const created = steps.indexOf("github.repository.create");
    expect(steps[steps.indexOf("apply:lockfile", created) - 1]).toBe("github.repository.create");
  });

  it("updates a repository whose declared field changed at GitHub, planning only what `only` names", async () => {
    fakes.github.override("repository", "website", { has_wiki: true });
    const { runId, report } = await apply({ only: [id.website] });
    expect(report.plan.steps).toEqual([
      {
        id: id.website,
        vendor: "github",
        type: "repository",
        action: "update",
        binding: "R_website",
        fields: [{ path: "has_wiki", desired: false, actual: true }],
        replace: [],
      },
    ]);
    expect(report.results).toEqual([{ id: id.website, action: "update", status: "done", binding: "R_website" }]);
    expect(fakes.github.state.objects["github_repository/website"]).toMatchObject({ state: { has_wiki: false } });
    const update = ops(await app.client.ledger(runId)).find(([op]) => op === "github.repository.update");
    expect(update?.[1]).toMatchObject({ id: "R_website", expect: { action: "update", replace: [] } });
    // The binding did not change: nothing written.
    expect(report.lockfile.written).toBe(false);
    expect(commits).toEqual([]);
  });

  it("asks about a repository GitHub no longer has, and recreates or forgets it as answered", async () => {
    fakes.github.remove("repository", "docs");
    const asked = await apply({ only: [id.docs] });
    expect(asked.report.plan.steps).toEqual([
      { id: id.docs, vendor: "github", type: "repository", action: "gone", binding: "R_docs" },
    ]);
    expect(asked.report.results).toEqual([{ id: id.docs, action: "gone", status: "skipped", binding: "R_docs" }]);
    expect(ops(await app.client.ledger(asked.runId)).map(([op]) => op)).not.toContain("github.repository.create");

    const recreated = await apply({ only: [id.docs], answers: { [id.docs]: "recreate" } });
    expect(recreated.report.plan.steps).toMatchObject([{ action: "gone", answer: "recreate" }]);
    const made = resultOf(recreated.report, id.docs)!;
    expect(made).toMatchObject({ status: "done", binding: expect.stringMatching(/^node_id-\d+$/) });
    expect(readLockfile(root).bindings[id.docs]).toEqual({ type: "github.repository", id: made.binding });

    // Made under the provider's id for it, which the fake imports it by.
    const [at] = Object.entries(fakes.github.state.objects).find(
      ([, o]) => "state" in o && o.state.node_id === made.binding,
    )!;
    fakes.github.remove("repository", at.slice("github_repository/".length));
    const forgotten = await apply({ only: [id.docs], answers: { [id.docs]: "forget" } });
    expect(forgotten.report.results).toEqual([{ id: id.docs, action: "gone", status: "done" }]);
    expect(readLockfile(root).bindings[id.docs]).toBeUndefined();
    expect(commits.at(-1)?.message).toBe(`Apply: unbind ${id.docs} (github.repository ${made.binding})`);
  });

  it("asks about an orphaned binding, and forgets it, or deletes its object, as answered", async () => {
    const { bindings } = readLockfile(root);
    writeLockfile(root, { ...bindings, [id.old]: { type: "github.repository", id: "R_old" } });
    fakes.github.put("repository", "old", { name: "old", node_id: "R_old" }, { from: "sanoma" });

    // A Stripe product cannot be deleted by apply: the answer is refused, and the binding stays.
    const kept = await apply({ only: [id.basic], answers: { [id.basic]: "delete" } });
    expect(kept.report.plan.problems).toEqual([
      { file: "resources/billing/stripe.ts", message: "basic: apply cannot delete it: a stripe.product is read-only" },
    ]);
    expect(kept.report.results).toMatchObject([{ id: id.basic, status: "skipped" }]);

    const forgotten = await apply({ only: [id.basic], answers: { [id.basic]: "forget" } });
    expect(forgotten.report.results).toEqual([{ id: id.basic, action: "orphan", status: "done" }]);
    expect(readLockfile(root).bindings[id.basic]).toBeUndefined();

    const deleted = await apply({ only: [id.old], answers: { [id.old]: "delete" } });
    expect(deleted.report.plan.steps).toEqual([
      {
        id: id.old,
        vendor: "github",
        type: "repository",
        action: "orphan",
        key: id.old,
        binding: "R_old",
        answer: "delete",
      },
    ]);
    expect(deleted.report.results).toEqual([{ id: id.old, action: "orphan", status: "done" }]);
    expect(ops(await app.client.ledger(deleted.runId))).toContainEqual(["github.repository.delete", { id: "R_old" }]);
    expect(fakes.github.state.objects["github_repository/old"]).toBeUndefined();
    expect(readLockfile(root).bindings[id.old]).toBeUndefined();
  });

  it("binds a declaration to the object the input gives, and says what it cannot bind", async () => {
    const { report } = await apply({ only: [id.docsMain], bind: { [id.docsMain]: "docs:main" } });
    // Given by its import id, bound by its binding id.
    expect(report.plan.steps).toEqual([
      {
        id: id.docsMain,
        vendor: "github",
        type: "branch_protection",
        action: "bind",
        binding: "BPR_docs:main",
        source: "given",
      },
    ]);
    expect(readLockfile(root).bindings[id.docsMain]).toEqual({ type: "github.branch_protection", id: "BPR_docs:main" });

    const nothing = await apply({
      only: [id.docsMain, "resources/nowhere.ts#x"],
      bind: { [id.docsMain]: "docs:nope", "resources/nowhere.ts#y": "y" },
    });
    expect(nothing.report.plan.steps).toEqual([]);
    expect(nothing.report.plan.problems).toEqual([
      { message: "only: resources/nowhere.ts#x is no declared resource" },
      { message: "bind: resources/nowhere.ts#y is no declared resource" },
      { file: "resources/identity/rules.ts", message: "docsMain: no github.branch_protection docs:nope to bind" },
    ]);
  });

  it("asks one approval where the policy holds a change, covering every change with the plan, then makes them", async () => {
    fakes.github.override("repository", "website", { has_wiki: true });
    const runId = await app.client.apply({}, { startedBy: careful });
    await waitFor(pending(() => app.client, runId));
    const [approval] = await app.client.approvals(runId);
    expect(approval).toMatchObject({
      title: "Apply resource changes",
      approver: "lead",
      requestedBy: "workflow",
      covers: ["github.repository.create", "github.repository.update"],
    });
    // Nothing is changed before it is approved.
    expect(ops(await app.client.ledger(runId)).filter(([op]) => op.endsWith(".create"))).toEqual([]);
    await app.client.decide(runId, { decision: "approve", by: { id: "lead" } });
    const report = await app.client.applyReport(runId);
    expect(JSON.parse(approval!.details!)).toEqual(report.plan);
    expect(report.results.filter((r) => r.status === "done").map((r) => r.action)).toEqual([
      "none",
      "create",
      "update",
      "none",
      "none",
      "bind",
    ]);
    // The one approval covered both calls: the policy held neither again.
    expect(await app.client.approvals(runId)).toHaveLength(1);
  });

  it("reports a change to the lockfile that apply did not make as a rebind", async () => {
    await apply();
    const { bindings } = readLockfile(root);
    writeLockfile(root, { ...bindings, [id.website]: { type: "github.repository", id: "R_other" } });
    const { report } = await apply({ only: [id.website] });
    expect(report.plan.rebinds).toEqual([
      { key: id.website, type: "github.repository", kind: "rebind", from: "R_website", to: "R_other" },
    ]);
    // And not again, once apply has written it.
    await apply({ answers: { [id.website]: "forget" } });
    expect((await apply({ only: [id.website] })).report.plan.rebinds).toEqual([]);
  });

  it("is the only workflow that may change a declared resource", () => {
    const sneak = defineWorkflow({
      name: "sneak",
      trigger: "manual",
      input: z.object({}),
      uses: [github.repository.create],
      run: async (ctx) => ctx.github.repository.create({ desired: { name: "x" } }),
    });
    expect(() => resolveConfig({ ...app.config, workflows: [sneak] })).toThrow(
      "github.repository.create changes a declared resource, which only apply does",
    );
  });
});

// Acme: two writable types through the real OpenTofu driver over a `stateBridge`. A site's region
// cannot change in place, and its token is write-only; a hook names its site by the site's id,
// and holds no data, so one gone is made again.
const site = {
  typeName: "acme_site",
  schemaVersion: 0,
  schema: z.object({
    id: z.string().nullish(),
    name: z.string(),
    region: z.string().nullish(),
    token: z.string().nullish(),
  }),
  fields: { immutable: ["region"], vendorOwned: ["id"], writeOnly: ["token"] },
  shape: { attributes: ["id", "name", "region", "token"], secret: ["token"] },
};
const hook = {
  typeName: "acme_hook",
  schemaVersion: 0,
  schema: z.object({ id: z.string().nullish(), site_id: z.string(), url: z.string() }),
  fields: { immutable: [], vendorOwned: ["id"], writeOnly: [] },
  shape: { attributes: ["id", "site_id", "url"] },
};
const acmeTf = tfConnector({
  vendor: "acme",
  provider: { source: "acme/acme", version: "1.0.0", protocol: 6 },
  types: {
    site: { tf: site, title: "Site", identity: "name", find: ({ name }) => name, writable: true },
    hook: { tf: hook, title: "Hook", identity: "url", find: ({ url }) => url, writable: true, stateless: true },
  },
  references: { hook: { site_id: { type: "acme.site", by: ["id"] } } },
  info: { title: "Acme", package: "@acme/connector" },
});

describe("the apply workflow on a vendor that replaces", () => {
  const root = mkdtempSync(join(tmpdir(), "sanoma-apply-acme-"));
  const file = join(root, "resources/acme.ts");
  const declare = (region: string) =>
    writeFileSync(
      file,
      `import { acme } from "@acme/connector/resources";\nimport { secret } from "sanoma/resources";\n\n` +
        `export const web = acme.site({ name: "web", region: "${region}", token: secret("ACME_TOKEN") });\n\n` +
        `export const deploys = acme.hook({ url: "https://example.com/deploys", site_id: web });\n\n` +
        `export default [web, deploys];\n`,
    );
  mkdirSync(join(root, "resources"));
  declare("eu");
  const token = "token-no-record-may-hold";
  beforeAll(() => {
    process.env.ACME_TOKEN = token;
  });
  afterAll(() => {
    delete process.env.ACME_TOKEN;
    rmSync(root, { recursive: true, force: true });
  });
  const state: BridgeState = { objects: {} };
  const bridge = stateBridge(state, [], { acme_site: site, acme_hook: hook });
  const acme = withSetup(acmeTf.connector, { driver: () => acmeTf.driver(bridge, () => ({})) });
  const { source, commits } = recordingSource(root);
  const app = useTestApp(
    { workflows: [], connectors: [acme], policy, ledger: memoryLedger(), root },
    { databaseUrl: testDatabaseUrl("apply-acme"), source },
  );
  const web = "resources/acme.ts#web";
  const deploys = "resources/acme.ts#deploys";
  const objectOf = (typeName: string, binding: string) =>
    (state.objects[`${typeName}/${binding}`] as { state: Record<string, unknown> } | undefined)?.state;

  async function apply(input: ApplyInput = {}) {
    const runId = await app.client.apply(input, { startedBy: alice });
    return { runId, report: await app.client.applyReport(runId) };
  }

  it("creates a site, then its hook given the site's new binding, and records no secret", async () => {
    const { runId, report } = await apply();
    expect(actions(report)).toEqual([
      ["acme.ts#web", "create"],
      ["acme.ts#deploys", "create"],
    ]);
    // Planned before the site exists: the hook names it by its name.
    expect(report.plan.steps[1]).toMatchObject({ planned: { site_id: "web" } });
    const siteId = report.lockfile.bindings[web]!.id;
    const made = objectOf("acme_hook", report.lockfile.bindings[deploys]!.id);
    expect(made).toMatchObject({ site_id: siteId, url: "https://example.com/deploys" });
    // The driver resolved the secret for the vendor; the run kept its marker only.
    expect(objectOf("acme_site", siteId)).toMatchObject({ name: "web", region: "eu", token });
    const created = ops(await app.client.ledger(runId)).find(([op]) => op === "acme.site.create");
    expect(created?.[1]).toEqual({ desired: { name: "web", region: "eu", token: { $secret: "ACME_TOKEN" } } });
    expect(JSON.stringify(await app.client.ledger(runId))).not.toContain(token);
    expect(JSON.stringify(await app.raw.listWorkflowSteps(runId))).not.toContain(token);
    expect(JSON.stringify(report)).not.toContain(token);
    expect(commits.map((c) => c.message)).toEqual([
      `Apply: create ${web} (acme.site ${siteId})`,
      `Apply: create ${deploys} (acme.hook ${report.lockfile.bindings[deploys]!.id})`,
    ]);
  });

  it("replaces a site whose region changed, and binds the new one", async () => {
    const before = readLockfile(root).bindings[web]!.id;
    declare("us");
    const { runId, report } = await apply({ only: [web] });
    expect(report.plan.steps).toEqual([
      {
        id: web,
        vendor: "acme",
        type: "site",
        action: "replace",
        binding: before,
        fields: [{ path: "region", desired: "us", actual: "eu" }],
        replace: ["region"],
      },
    ]);
    const after = resultOf(report, web)!.binding!;
    expect(after).not.toBe(before);
    expect(objectOf("acme_site", before)).toBeUndefined();
    expect(objectOf("acme_site", after)).toMatchObject({ region: "us" });
    expect(readLockfile(root).bindings[web]).toEqual({ type: "acme.site", id: after });
    expect(commits.at(-1)?.message).toBe(`Apply: rebind ${web} (acme.site ${after})`);
    const update = ops(await app.client.ledger(runId)).find(([op]) => op === "acme.site.update");
    expect(update?.[1]).toMatchObject({ expect: { action: "replace", replace: ["region"] } });
  });

  it("makes a hook gone at the vendor again without asking: it holds no data", async () => {
    const before = readLockfile(root).bindings[deploys]!.id;
    delete state.objects[`acme_hook/${before}`];
    const { report } = await apply({ only: [deploys] });
    expect(actions(report)).toEqual([["acme.ts#deploys", "create"]]);
    const after = resultOf(report, deploys)!;
    expect(after).toMatchObject({ status: "done", binding: expect.not.stringMatching(before) });
    expect(objectOf("acme_hook", after.binding!)).toMatchObject({ site_id: readLockfile(root).bindings[web]!.id });
  });

  it("fails an update the vendor plans otherwise by the time it runs, and goes on", async () => {
    declare("ap");
    const runId = await app.client.apply({}, { startedBy: careful });
    await waitFor(pending(() => app.client, runId));
    // While the change waits for the lead, someone moves the site at the vendor: now it is a replace no more.
    const binding = readLockfile(root).bindings[web]!.id;
    objectOf("acme_site", binding)!.region = "ap";
    objectOf("acme_site", binding)!.name = "renamed";
    await app.client.decide(runId, { decision: "approve", by: { id: "lead" } });
    const report = await app.client.applyReport(runId);
    expect(report.plan.steps[0]).toMatchObject({ id: web, action: "replace" });
    expect(resultOf(report, web)).toMatchObject({
      status: "failed",
      binding,
      error: expect.stringContaining("was planned to replace, and now plans to update"),
    });
    expect(resultOf(report, deploys)).toMatchObject({ status: "done" });
  });
});
