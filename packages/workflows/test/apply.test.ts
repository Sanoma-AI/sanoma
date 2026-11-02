import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tfConnector } from "@sanoma-ai/bridge/connector";
import { type BridgeState, stateBridge } from "@sanoma-ai/bridge/fake";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { fakeHost, testRepository } from "@sanoma-ai/testing/host";
import { fakeWakeup } from "@sanoma-ai/testing/wakeup";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { LOCKFILE, readLockfile, serializeLockfile, writeLockfile } from "../src/describe.ts";
import {
  type ApplyInput,
  type ApplyReport,
  defineWorkflow,
  DriverError,
  type LedgerRecord,
  memoryLedger,
  memorySecrets,
  type PlanStep,
  type Principal,
  resolveConfig,
  type Source,
  withSetup,
} from "../src/index.ts";
import { chainDataFile, fakeMail, mailDataFile, recordsFor } from "./fakes/mail.ts";
import { companyFakes } from "./fixtures/company/fakes.ts";
import company from "./fixtures/company/sanoma.config.ts";
import { pending, rootWith, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. Apply on a copy of a company's data files and lockfile (so the
// fixture's stay as they are), against fakes: the company's GitHub and Stripe, and Acme, a
// vendor made here over a `stateBridge` whose sites are replaced when their region changes.
const alice = { id: "alice" };
const careful = { id: "careful" };
// The policy holds every change of careful's for the lead, as a team would; the approval that
// covers a change lifts the hold for it.
const POLICY = `@hold("lead")
forbid (principal == Sanoma::Principal::"careful", action in Sanoma::Action::"effect:write", resource);
`;
const PEOPLE = `import { sanoma } from "sanoma/resources";

export const alice = sanoma.person({ id: "alice" });
export const careful = sanoma.person({ id: "careful" });
export const lead = sanoma.person({ id: "lead" });
`;
/** A root with the policy and the people, for a test to add its data files to. */
const rootWithPolicy = () => rootWith({ "policies/policy.cedar": POLICY, "resources/people.ts": PEOPLE });

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
  const root = rootWithPolicy();
  const fakes = companyFakes();
  const { source, commits } = recordingSource(root);
  const app = useTestApp(
    { workflows: [], connectors: fakes.connectors, ledger: memoryLedger(), root },
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
  // The fixture's data files and lockfile, the people, and a repository nobody has made yet.
  beforeEach(() => {
    rmSync(join(root, "resources"), { recursive: true, force: true });
    cpSync(join(dirname(company.file!), "resources"), join(root, "resources"), { recursive: true });
    writeFileSync(join(root, "resources/people.ts"), PEOPLE);
    writeFileSync(
      join(root, "resources/identity/blog.ts"),
      `import { github } from "@sanoma-ai/connector-github/resources";\n\n` +
        `export const blog = github.repository({ owner: "acme", name: "blog", visibility: "private" });\n\nexport default [blog];\n`,
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
      ["github.repository.create", { desired: { owner: "acme", name: "blog", visibility: "private" } }],
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
    // Meanwhile someone binds another resource: the run writes its own changes onto that.
    const meanwhile = { type: "github.repository", id: "R_meanwhile" };
    writeLockfile(root, { ...readLockfile(root).bindings, [id.old]: meanwhile });
    await app.client.decide(runId, { decision: "approve", by: { id: "lead" } });
    const report = await app.client.applyReport(runId);
    expect(readLockfile(root).bindings).toMatchObject({ [id.old]: meanwhile, [id.blog]: expect.anything() });
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

  it("leaves a change operation to any workflow's uses: its call refuses a declared object", () => {
    const create = resolveConfig(app.config).ops.get("github.repository.create")!;
    const own = defineWorkflow({
      name: "own",
      trigger: "manual",
      input: z.object({}),
      uses: [create],
      run: async () => 1,
    });
    expect(resolveConfig({ ...app.config, workflows: [own] }).workflows.has("own")).toBe(true);
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
  const root = rootWithPolicy();
  const file = join(root, "resources/acme.ts");
  const declare = (region: string) =>
    writeFileSync(
      file,
      `import { acme } from "@acme/connector/resources";\nimport { secret } from "sanoma/resources";\n\n` +
        `export const web = acme.site({ name: "web", region: "${region}", token: secret("ACME_TOKEN") });\n\n` +
        `export const deploys = acme.hook({ url: "https://example.com/deploys", site_id: web });\n\n` +
        `export default [web, deploys];\n`,
    );
  declare("eu");
  const token = "token-no-record-may-hold";
  beforeAll(() => {
    process.env.ACME_TOKEN = token;
  });
  afterAll(() => {
    delete process.env.ACME_TOKEN;
  });
  const state: BridgeState = { objects: {} };
  const bridge = stateBridge(state, [], { acme_site: site, acme_hook: hook });
  const acme = withSetup(acmeTf.connector, { driver: () => acmeTf.driver(bridge, () => ({})) });
  const { source, commits } = recordingSource(root);
  const app = useTestApp(
    {
      workflows: [],
      connectors: [acme],
      ledger: memoryLedger(),
      root,
      secrets: { bindings: { ACME_TOKEN: { env: "ACME_TOKEN" } } },
    },
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
        // A replace makes a new object: its id is known only after.
        unknown: ["id"],
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

    // Unless answered otherwise.
    delete state.objects[`acme_hook/${after.binding}`];
    const forgotten = await apply({ only: [deploys], answers: { [deploys]: "forget" } });
    expect(forgotten.report.plan.steps).toMatchObject([{ action: "gone", answer: "forget" }]);
    expect(readLockfile(root).bindings[deploys]).toBeUndefined();
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

describe("the apply workflow on a wakeup", () => {
  const root = rootWithPolicy();
  const repo = testRepository();
  writeFileSync(
    join(root, "resources/infra.ts"),
    [
      'import { testhost } from "@sanoma-ai/testing-host/resources";',
      'import { testwakeup } from "@sanoma-ai/testing-wakeup/resources";',
      "",
      `export const app = testhost.app({ name: "company", source: ${JSON.stringify(repo.url)}, ref: "main", port: 0 });`,
      'export const wake = testwakeup.timer({ name: "wake", host: app });',
      "",
    ].join("\n"),
  );
  const host = fakeHost(async () => ({ url: "http://127.0.0.1:4100", stop: async () => {} }));
  const wakeup = fakeWakeup();
  const app = useTestApp(
    { workflows: [], connectors: [host.connector, wakeup.connector], ledger: memoryLedger(), root },
    { databaseUrl: testDatabaseUrl("apply-wakeup"), source: recordingSource(root).source },
  );
  const timer = async () =>
    (
      (await wakeup.driver.ops["timer.read"]!(
        { id: "wake" },
        {
          idempotencyKey: "read",
          runId: "test",
          opId: "testwakeup.timer.read",
          attempt: 1,
          secrets: memorySecrets({}),
        },
      )) as { state?: Record<string, unknown> }
    ).state;
  beforeAll(() => repo.commit());
  afterAll(async () => {
    await host.close();
    repo.remove();
  });

  async function apply(input: ApplyInput = {}) {
    return app.client.applyReport(await app.client.apply(input, { startedBy: alice }));
  }

  it("gives a wakeup its host's URL from the host's state: made in the same run, then found", async () => {
    const made = await apply();
    expect(actions(made)).toEqual([
      ["infra.ts#app", "create"],
      ["infra.ts#wake", "create"],
    ]);
    expect(resultOf(made, "resources/infra.ts#app")!.host!.url).toBe("http://127.0.0.1:4100");
    expect(await timer()).toEqual({ name: "wake", host: "http://127.0.0.1:4100" });
    // Found the next time, so the wakeup is as declared, and drift says so.
    expect(actions(await apply({ only: ["resources/infra.ts#wake"] }))).toEqual([["infra.ts#wake", "none"]]);
    const drift = await app.client.driftReport(await app.client.drift({ startedBy: alice }));
    expect(drift.resources.find((r) => r.id === "resources/infra.ts#wake")).toMatchObject({ status: "clean" });
  });
});

describe("the apply workflow on a field taken from another resource's state", () => {
  const root = rootWithPolicy();
  writeFileSync(join(root, "resources/mail.ts"), mailDataFile);
  const fake = fakeMail();
  const app = useTestApp(
    { workflows: [], connectors: [fake.connector], ledger: memoryLedger(), root },
    { databaseUrl: testDatabaseUrl("apply-from"), source: recordingSource(root).source },
  );
  const sending = "resources/mail.ts#sending";
  const dns = "resources/mail.ts#dns";
  beforeEach(() => {
    rmSync(join(root, LOCKFILE), { force: true });
    fake.reset();
  });

  async function apply(input: ApplyInput = {}) {
    const runId = await app.client.apply(input, { startedBy: alice });
    return { runId, report: await app.client.applyReport(runId) };
  }

  it("creates the domain, then the record set with the domain's records, planned unknown before", async () => {
    const { runId, report } = await apply();
    expect(actions(report)).toEqual([
      ["mail.ts#sending", "create"],
      ["mail.ts#dns", "create"],
    ]);
    // Planned before the domain exists: its records are not known yet.
    expect(report.plan.steps[1]).toMatchObject({ planned: { records: null }, unknown: ["records"] });
    const plans = ops(await app.client.ledger(runId)).filter(([op]) => op === "mail.records.plan");
    expect(plans).toEqual([["mail.records.plan", { desired: { name: "example.com/mail", records: null } }]]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([
      [sending, "done"],
      [dns, "done"],
    ]);
    expect(fake.state.sets.get("example.com/mail")).toEqual({
      name: "example.com/mail",
      records: recordsFor("example.com"),
    });

    // Found the next time: as declared, until the domain asks for other records.
    expect(actions((await apply()).report)).toEqual([
      ["mail.ts#sending", "none"],
      ["mail.ts#dns", "none"],
    ]);
    const more = [...recordsFor("example.com"), { type: "TXT" as const, name: "example.com", content: "v=spf1 -all" }];
    fake.update(({ domains }) => domains.set("example.com", { name: "example.com", records: more }));
    const again = await apply({ only: [dns] });
    expect(again.report.plan.steps).toMatchObject([{ id: dns, action: "update" }]);
    expect(fake.state.sets.get("example.com/mail")?.records).toEqual(more);
  });

  it("plans a bound record set without its records while its domain is gone, as drift compares it", async () => {
    await apply();
    fake.update(({ domains }) => domains.delete("example.com"));
    const { runId, report } = await apply({ only: [dns] });
    expect(report.plan.steps).toMatchObject([{ id: dns, action: "none" }]);
    expect(resultOf(report, dns)).toMatchObject({ status: "done" });
    const plans = ops(await app.client.ledger(runId)).filter(([op]) => op === "mail.records.plan");
    expect(plans).toEqual([["mail.records.plan", { id: "example.com/mail", desired: { name: "example.com/mail" } }]]);
  });

  it("plans a record set to change with its domain's planned update, in one approval, and gives it the new records", async () => {
    await apply();
    // The domain is pending again, its records gone, and so are the set's.
    fake.update(({ domains, sets }) => {
      domains.set("example.com", { name: "example.com", records: null });
      sets.set("example.com/mail", { name: "example.com/mail", records: [] });
    });
    const runId = await app.client.apply({}, { startedBy: careful });
    await waitFor(pending(() => app.client, runId));
    // Planned up front: the set's records are unknown while the domain's update is to come.
    const [approval] = await app.client.approvals(runId);
    expect(approval).toMatchObject({ covers: ["mail.domain.update", "mail.records.update"] });
    const plans = ops(await app.client.ledger(runId)).filter(([op]) => op === "mail.records.plan");
    expect(plans).toEqual([
      ["mail.records.plan", { id: "example.com/mail", desired: { name: "example.com/mail", records: null } }],
    ]);
    await app.client.decide(runId, { decision: "approve", by: { id: "lead" } });
    const report = await app.client.applyReport(runId);
    expect(actions(report)).toEqual([
      ["mail.ts#sending", "update"],
      ["mail.ts#dns", "update"],
    ]);
    expect(report.results.map((r) => [r.id, r.action, r.status])).toEqual([
      [sending, "update", "done"],
      [dns, "update", "done"],
    ]);
    // Run with the records the domain's update listed.
    expect(fake.state.sets.get("example.com/mail")?.records).toEqual(recordsFor("example.com"));
  });

  it("fails the record set's step before its driver is called while the domain lists no records yet", async () => {
    fake.update(({ domains }) => domains.set("example.com", { name: "example.com", records: null }));
    const { report } = await apply();
    expect(resultOf(report, dns)).toEqual({
      id: dns,
      action: "create",
      status: "failed",
      error: `its records come from ${sending}, whose state has no records yet`,
    });
    expect(fake.calls.map((c) => c.op)).not.toContain("mail.records.create");
  });

  it("fails the record set's step before its driver is called when the domain could not be made", async () => {
    fake.failNext("mail.domain.create", new DriverError("mail: the domain is refused", { retryable: false }));
    const { report } = await apply();
    expect(report.results).toEqual([
      { id: sending, action: "create", status: "failed", error: expect.stringContaining("the domain is refused") },
      {
        id: dns,
        action: "create",
        status: "failed",
        error: `its records come from ${sending}, which has no state yet`,
      },
    ]);
    // The record set's driver was never called to change anything.
    expect(fake.calls.map((c) => c.op).filter((op) => !/\.(import|plan)$/.test(op))).toEqual(["mail.domain.create"]);
    expect(report.lockfile.bindings).toEqual({});
  });

  it("plans the record set as none while its domain's update leaves the records as they are", async () => {
    await apply();
    // To be verified again: an update that changes no record.
    fake.update(({ domains }) =>
      domains.set("example.com", { name: "example.com", records: recordsFor("example.com"), verified: false }),
    );
    const { runId, report } = await apply();
    expect(actions(report)).toEqual([
      ["mail.ts#sending", "update"],
      ["mail.ts#dns", "none"],
    ]);
    // Planned with the records the domain holds, which its update keeps.
    const plans = ops(await app.client.ledger(runId)).filter(([op]) => op === "mail.records.plan");
    expect(plans).toEqual([
      [
        "mail.records.plan",
        { id: "example.com/mail", desired: { name: "example.com/mail", records: recordsFor("example.com") } },
      ],
    ]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([
      [sending, "done"],
      [dns, "done"],
    ]);
  });

  it("fails the record set's step when its domain's update fails, never given the records it held before", async () => {
    await apply();
    // A key rotated: the domain's update lists other records, and the set holds the old ones.
    const old = [{ type: "TXT" as const, name: "mail._domainkey.example.com", content: "p=old" }];
    fake.update(({ domains, sets }) => {
      domains.set("example.com", { name: "example.com", records: old });
      sets.set("example.com/mail", { name: "example.com/mail", records: old });
    });
    fake.failNext("mail.domain.update", new DriverError("mail: the domain is refused", { retryable: false }));
    const { report } = await apply();
    // The update's plan lists other records there: the set's are unknown, its update in the plan.
    expect(report.plan.steps).toMatchObject([
      { id: sending, action: "update" },
      { id: dns, action: "update", unknown: ["records"] },
    ]);
    expect(report.results).toEqual([
      {
        id: sending,
        action: "update",
        status: "failed",
        binding: "example.com",
        error: expect.stringContaining("the domain is refused"),
      },
      {
        id: dns,
        action: "update",
        status: "failed",
        binding: "example.com/mail",
        error: `its records come from ${sending}, which has no state yet`,
      },
    ]);
    expect(fake.calls.map((c) => c.op)).not.toContain("mail.records.update");
    expect(fake.state.sets.get("example.com/mail")?.records).toEqual(old);
  });

  it("fails each step down a chain whose first change fails, as the one between waits", async () => {
    const copy = "resources/mail.ts#copy";
    writeFileSync(join(root, "resources/mail.ts"), chainDataFile);
    try {
      expect((await apply()).report.results.map((r) => [r.id, r.status])).toEqual([
        [sending, "done"],
        [dns, "done"],
        [copy, "done"],
      ]);
      expect(fake.state.copies.get("example.com/copy")?.records).toEqual(recordsFor("example.com"));
      const old = [{ type: "TXT" as const, name: "mail._domainkey.example.com", content: "p=old" }];
      fake.update(({ domains, sets, copies }) => {
        domains.set("example.com", { name: "example.com", records: old });
        sets.set("example.com/mail", { name: "example.com/mail", records: old });
        copies.set("example.com/copy", { name: "example.com/copy", records: old });
      });
      fake.failNext("mail.domain.update", new DriverError("mail: the domain is refused", { retryable: false }));
      const { report } = await apply();
      expect(report.plan.steps).toMatchObject([
        { id: sending, action: "update" },
        { id: dns, action: "update", unknown: ["records"] },
        { id: copy, action: "update", unknown: ["records"] },
      ]);
      expect(report.results.map((r) => [r.id, r.status, r.error])).toEqual([
        [sending, "failed", expect.stringContaining("the domain is refused")],
        [dns, "failed", `its records come from ${sending}, which has no state yet`],
        // The set waited: the copy is not given the records the set held before.
        [copy, "failed", `its records come from ${dns}, which has no state yet`],
      ]);
      expect(fake.state.copies.get("example.com/copy")?.records).toEqual(old);
    } finally {
      writeFileSync(join(root, "resources/mail.ts"), mailDataFile);
    }
  });

  it("runs a bound record set's other change without its records while its domain is gone, as planned", async () => {
    writeFileSync(
      join(root, "resources/mail.ts"),
      mailDataFile.replace("records: sending", 'label: "Mail", records: sending'),
    );
    try {
      await apply();
      fake.update(({ domains, sets }) => {
        domains.delete("example.com");
        sets.set("example.com/mail", { name: "example.com/mail", label: "Old", records: recordsFor("example.com") });
      });
      const { report } = await apply({ only: [dns] });
      expect(report.plan.steps).toMatchObject([{ id: dns, action: "update" }]);
      expect(resultOf(report, dns)).toMatchObject({ status: "done" });
      // Its label changed, its records kept.
      expect(fake.state.sets.get("example.com/mail")).toEqual({
        name: "example.com/mail",
        label: "Mail",
        records: recordsFor("example.com"),
      });
    } finally {
      writeFileSync(join(root, "resources/mail.ts"), mailDataFile);
    }
  });

  it("gives a record set its domain's records when the domain's failed update would not have changed them", async () => {
    writeFileSync(
      join(root, "resources/mail.ts"),
      mailDataFile.replace("records: sending", 'label: "Mail", records: sending'),
    );
    try {
      await apply();
      fake.update(({ domains, sets }) => {
        domains.set("example.com", { name: "example.com", records: recordsFor("example.com"), verified: false });
        sets.set("example.com/mail", { name: "example.com/mail", label: "Old", records: recordsFor("example.com") });
      });
      fake.failNext("mail.domain.update", new DriverError("mail: the check failed", { retryable: false }));
      const { report } = await apply();
      expect(report.results.map((r) => [r.id, r.action, r.status])).toEqual([
        [sending, "update", "failed"],
        [dns, "update", "done"],
      ]);
      expect(fake.state.sets.get("example.com/mail")).toMatchObject({
        label: "Mail",
        records: recordsFor("example.com"),
      });
    } finally {
      writeFileSync(join(root, "resources/mail.ts"), mailDataFile);
    }
  });

  it("does nothing to a record set planned unknown whose records turned out unchanged", async () => {
    await apply();
    // The domain is pending again; the set already holds the records its update lists.
    fake.update(({ domains }) => domains.set("example.com", { name: "example.com", records: null }));
    const { runId, report } = await apply();
    expect(report.plan.steps).toMatchObject([
      { id: sending, action: "update" },
      { id: dns, action: "update", unknown: ["records"] },
    ]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([
      [sending, "done"],
      [dns, "done"],
    ]);
    // Planned again with the records known: none, so its driver is not called to write.
    const plans = ops(await app.client.ledger(runId)).filter(([op]) => op === "mail.records.plan");
    expect(plans.map(([, input]) => input)).toEqual([
      { id: "example.com/mail", desired: { name: "example.com/mail", records: null } },
      { id: "example.com/mail", desired: { name: "example.com/mail", records: recordsFor("example.com") } },
    ]);
    expect(fake.calls.map((c) => c.op)).not.toContain("mail.records.update");
  });

  it("replaces a record set planned unknown whose known records force a replace, expecting the fresh plan", async () => {
    await apply();
    // The domain is pending again; the set holds a record its update no longer lists.
    const extra = { type: "TXT" as const, name: "example.com", content: "v=spf1 -all" };
    fake.update(({ domains, sets }) => {
      domains.set("example.com", { name: "example.com", records: null });
      sets.set("example.com/mail", { name: "example.com/mail", records: [...recordsFor("example.com"), extra] });
    });
    const { runId, report } = await apply();
    expect(report.plan.steps).toMatchObject([
      { id: sending, action: "update" },
      { id: dns, action: "update", replace: [], unknown: ["records"] },
    ]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([
      [sending, "done"],
      [dns, "done"],
    ]);
    const update = ops(await app.client.ledger(runId)).find(([op]) => op === "mail.records.update");
    expect(update?.[1]).toMatchObject({ expect: { action: "replace", replace: ["records"] } });
    expect(fake.state.sets.get("example.com/mail")?.records).toEqual(recordsFor("example.com"));
  });
});
