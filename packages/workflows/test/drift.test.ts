import { bluesky } from "@sanoma/connector-bluesky";
import { fakeGithub, fakeStripe, testDatabaseUrl, type FakeGithubState } from "@sanoma/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { describeConfig, readResources } from "../src/describe.ts";
import {
  allow,
  allowAll,
  defineWorkflow,
  definePolicy,
  deny,
  type DriftReport,
  errorCode,
  type LedgerRecord,
  memoryLedger,
  type PolicyCall,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  startWorker,
  type Worker,
} from "../src/index.ts";
import company from "./fixtures/company/sanoma.config.ts";
import { marketingFakes } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. The company fixture's data files, checked against the GitHub
// and Stripe fakes, which hold an object for each declared resource as declared.
const databaseUrl = testDatabaseUrl("drift");
const alice = { id: "alice" };

const github = fakeGithub();
const stripe = fakeStripe();
const declared = readResources(company);

/** Each resource type's provider type, and a recorded object of it to copy, when there is one. */
const PROVIDER: Record<string, { typeName: string; template?: string }> = {
  "github.repository": { typeName: "github_repository", template: "github_repository/sanoma" },
  "github.branch_protection": { typeName: "github_branch_protection" },
  "stripe.product": { typeName: "stripe_product", template: "stripe_product/prod_SanomaTest0001" },
  "stripe.webhook_endpoint": {
    typeName: "stripe_webhook_endpoint",
    template: "stripe_webhook_endpoint/we_SanomaTest0001",
  },
};

/**
 * Gives the fakes an object for each declared resource, holding what it declares: a recorded
 * object of its type copied (so it has the fields the vendor sets), or a new one, under its
 * import id, with the declared fields over it.
 */
function seed() {
  for (const r of declared) {
    const fake = r.vendor === "github" ? github : stripe;
    const { typeName, template } = PROVIDER[`${r.vendor}.${r.type}`]!;
    fake.update((state: FakeGithubState) => {
      const copied = template && state.objects[template];
      const object =
        copied && !("error" in copied)
          ? structuredClone(copied)
          : { typeName, state: {}, private: "", schemaVersion: 0 };
      // A read finds the object by its state's id: a repository's is its name, a rule's GitHub's own.
      object.state.id = r.type === "branch_protection" ? `BP_${r.name}` : r.name;
      state.objects[`${typeName}/${r.name}`] = object;
    });
    (fake.override as (type: string, id: string, fields: Record<string, unknown>) => void)(r.type, r.name, r.desired);
  }
}

const policyCalls: PolicyCall[] = [];
const ledger = memoryLedger();
const config: SanomaConfig = {
  ...company,
  drivers: [github.driver, stripe.driver],
  // Refuses Stripe products to "no-stripe", so one resource fails and the run goes on.
  policy: definePolicy((call) => {
    policyCalls.push(call);
    return call.actor.id === "no-stripe" && call.op.id === "stripe.product.import" ? deny("no Stripe") : allow();
  }),
  ledger,
  appName: "drift",
  databaseUrl,
};

let worker: Worker;
let client: SanomaClient;

beforeAll(async () => {
  worker = await startWorker(config);
  client = await SanomaClient.connect(config);
});

afterAll(async () => {
  await client?.close();
  await worker?.stop();
});

beforeEach(() => {
  github.reset();
  stripe.reset();
  seed();
  policyCalls.length = 0;
});

const byId = (report: DriftReport) => Object.fromEntries(report.resources.map((r) => [r.id, r]));
const opCalls = (records: LedgerRecord[]) => records.filter((r) => r.type === "op.called");

async function drift(startedBy = alice) {
  const runId = await client.drift({ startedBy });
  return { runId, report: await client.driftReport(runId) };
}

describe("the drift workflow", () => {
  it("reports every declared resource clean when the vendors hold what is declared", async () => {
    // The vendor reorders a set and sets a field nobody declared: neither is drift.
    github.override("repository", "website", { topics: ["astro", "website"] });
    github.override("repository", "docs", { delete_branch_on_merge: true });
    const { report } = await drift();
    expect(report.resources.map((r) => [r.id, r.vendor, r.type, r.name, r.status])).toEqual(
      declared.map((r) => [r.id, r.vendor, r.type, r.name, "clean"]),
    );
    expect(report.resources.every((r) => r.fields.length === 0)).toBe(true);
    expect(report.startedAt).toBeLessThanOrEqual(report.finishedAt);
  });

  it("reports one GitHub field and one Stripe field that changed, and a resource gone; the rest are clean", async () => {
    github.override("repository", "website", { has_wiki: true });
    stripe.override("product", "prod_SanomaFixturePro", { name: "Sanoma Professional" });
    stripe.remove("webhook_endpoint", "we_SanomaFixtureEvents");
    const { runId, report } = await drift();

    const rows = byId(report);
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
    expect(rows["resources/billing/stripe.ts#events"]).toMatchObject({ status: "gone", fields: [] });
    expect(report.resources.filter((r) => r.status === "clean").map((r) => r.id)).toEqual([
      "resources/identity/github.ts#docs",
      "resources/identity/github.ts#websiteMain",
      "resources/identity/rules.ts#docsMain",
    ]);

    // Every vendor call went through ctx: the policy saw each as a read, and the ledger has it.
    const calls = opCalls(await client.ledger(runId));
    const expected = [
      ["stripe.product.import", "prod_SanomaFixturePro"],
      ["stripe.product.read", "prod_SanomaFixturePro"],
      ["stripe.webhook_endpoint.import", "we_SanomaFixtureEvents"],
      ["github.repository.import", "website"],
      ["github.repository.read", "website"],
      ["github.repository.import", "docs"],
      ["github.repository.read", "docs"],
      ["github.branch_protection.import", "website:main"],
      ["github.branch_protection.read", "website:main"],
      ["github.branch_protection.import", "docs:main"],
      ["github.branch_protection.read", "docs:main"],
    ];
    expect(calls.map((r) => r.type === "op.called" && [r.op, (r.input as { id: string }).id])).toEqual(expected);
    expect(calls.every((r) => r.type === "op.called" && r.effect === "read" && r.decision.kind === "allow")).toBe(true);
    // The import of the endpoint that is gone failed, as the vendor answered.
    expect(calls[2]).toMatchObject({ error: { code: "driver_failed", vendorCode: "not_found" } });
    expect(policyCalls.map((c) => [c.op.id, c.effect, c.target])).toEqual(expected.map(([op, id]) => [op, "read", id]));
    // The run's record says what it compared against, and what it found.
    const records = await client.ledger(runId);
    expect(records[0]).toMatchObject({
      type: "run.started",
      input: {
        resources: declared.map(({ id, vendor, type, name, desired }) => ({ id, vendor, type, name, desired })),
      },
    });
    expect(records.at(-1)).toMatchObject({ type: "run.finished", output: report });
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
    expect((await client.run(runId))?.status).toBe("finished");
  });

  it("runs on a worker started again, which makes the built-in afresh", async () => {
    await worker.stop();
    worker = await startWorker(config);
    const { report } = await drift();
    expect(report.resources.every((r) => r.status === "clean")).toBe(true);
  });
});

describe("SanomaClient's drift", () => {
  it("lists drift runs by workflow, and refuses a report of a run that is none", async () => {
    const runId = await client.drift({ startedBy: alice });
    await client.driftReport(runId);
    const runs = await client.runs({ workflow: "drift", limit: 1 });
    expect(runs.map((r) => [r.runId, r.workflow, r.status])).toEqual([[runId, "drift", "finished"]]);
    expect(await client.runs({ workflow: "announce" })).toEqual([]);
    expect(errorCode(await client.driftReport("no-such-run").catch((e: unknown) => e))).toBe("run_not_found");
  });

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
  it("is added when the connectors declare resource types, using each type's import and read that has a driver", () => {
    const resolved = resolveConfig(config);
    expect(resolved.drift?.name).toBe("drift");
    expect(resolved.workflows).toContain(resolved.drift);
    const entry = describeConfig(config).workflows.find((wf) => wf.name === "drift");
    expect(entry).toMatchObject({ name: "drift", title: "Check resources for drift", builtin: true });
    expect(entry?.ops).toEqual(
      expect.arrayContaining([
        "github.repository.import",
        "github.repository.read",
        "github.branch_protection.import",
        "stripe.product.read",
        "stripe.webhook_endpoint.read",
      ]),
    );
    expect(entry?.outline).toMatchObject({ file: expect.stringMatching(/src\/drift\.ts$/) });
    // Without drivers it is there all the same, and uses nothing: each resource reports the missing driver.
    expect(describeConfig(company).workflows).toMatchObject([{ name: "drift", builtin: true, ops: [] }]);
  });

  it("is not added when no connector declares a resource type, and the config's own workflows are not built-in", () => {
    const marketing = { ...company, connectors: [bluesky], drivers: [] };
    expect(resolveConfig(marketing).drift).toBeUndefined();
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
