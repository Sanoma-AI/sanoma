import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fakeGithub } from "@sanoma/connector-github/fake";
import { fakeStripe } from "@sanoma/connector-stripe/fake";
import { testDatabaseUrl } from "@sanoma/testing";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineFake } from "../src/fake.ts";
import {
  allowAll,
  defineConnector,
  defineResource,
  defineWorkflow,
  errorCode,
  type LedgerRecord,
  memoryLedger,
  resolveConfig,
} from "../src/index.ts";
import { check, drive, type Expectation, loadScenarios, type Scenario } from "../src/scenario.ts";
import policy from "./fixtures/company/policies/policy.ts";
import company from "./fixtures/company/sanoma.config.ts";
import inspect from "./fixtures/company/workflows/inspect.ts";
import { failure, useApp } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. The company fixture's scenarios: the policy outcomes, seeded
// resources and drift results its feature files expect, on the inspect workflow, its policy and
// the built-in drift workflow, against GitHub's and Stripe's fakes.
const databaseUrl = testDatabaseUrl("steps");
const alice = { id: "alice" };

// The config's fakes are the templates each sandbox run copies, and the drivers, as a company
// running on fakes would pass them.
const github = fakeGithub();
const stripe = fakeStripe();
const companyConfig = {
  workflows: [inspect],
  connectors: company.connectors,
  file: company.file!,
  drivers: [github.driver, stripe.driver],
  fakes: [github, stripe],
  policy,
  scenarios: new URL("./fixtures/company/scenarios/", import.meta.url),
};
const loaded = loadScenarios(resolveConfig({ ...companyConfig, ledger: memoryLedger() }));
const scenario = (name: string): Scenario => loaded.scenarios.find((s) => s.name === name)!;
const passes = (s: Scenario) => s.expect.map((e) => ({ step: e.step, ok: true }));
/** What `check` says of each of these expectations, in the scenario's place, over the records. */
const against = (s: Scenario, expectations: Omit<Expectation, "step">[], records: LedgerRecord[]) =>
  check({ ...s, expect: expectations.map((e) => ({ step: "s", ...e }) as Expectation) }, records).map((c) => c.detail);
const call = (records: LedgerRecord[], op: string) =>
  records.find((r) => r.type === "op.called" && r.op === op) as Extract<LedgerRecord, { type: "op.called" }>;

describe("the company's scenarios", () => {
  const app = useApp(databaseUrl, "steps", () => companyConfig);
  const run = async (s: Scenario) => {
    const runId = await app.client.start(s.workflow, s.input, { startedBy: alice, sandbox: s.name });
    await drive(app.client, runId, s);
    return app.client.ledger(runId);
  };

  it("all load", () => {
    expect(loaded.errors).toEqual([]);
    expect(loaded.scenarios.map((s) => [s.file, s.workflow])).toEqual([
      ["drift.feature", "drift"],
      ["drift.feature", "drift"],
      ["drift.feature", "drift"],
      ["inspect.feature", "inspect"],
      ["inspect.feature", "inspect"],
      ["inspect.feature", "inspect"],
      ["inspect.feature", "inspect"],
    ]);
  });

  it.each(loaded.scenarios.map((s) => [s.name, s] as const))("%s", async (_, s) => {
    expect(check(s, await run(s))).toEqual(passes(s));
  });

  it("seeds a resource on the run's copy of the fake, and leaves the config's fake as it was", async () => {
    const recorded = github.state.objects["github_repository/sanoma"];
    const edited = await run(scenario("A repository as someone edited it at GitHub"));
    expect(call(edited, "github.repository.import").output).toMatchObject({
      gone: false,
      state: { description: "Edited at GitHub" },
    });
    const gone = await run(scenario("A repository GitHub no longer has ends the inspection"));
    expect(call(gone, "github.repository.import").output).toEqual({ id: "sanoma", gone: true });
    expect(gone.at(-1)).toMatchObject({ type: "run.finished", output: { repository: null, product: null } });
    expect(github.state.objects["github_repository/sanoma"]).toEqual(recorded);
    // Nothing reached the templates: each run imported through its own copy.
    expect(github.calls).toEqual([]);
    expect(stripe.calls).toEqual([]);
  });

  it("fails each policy and drift step with what the run did instead", async () => {
    const held = scenario("A product is read once finance says so");
    expect(
      against(
        held,
        [
          { denied: "github.repository.import" },
          { denied: "stripe.product.import" },
          { held: "github.repository.import", approver: "finance" },
          { held: "stripe.product.import", approver: "marketing-lead" },
        ],
        await run(held),
      ),
    ).toEqual([
      "github.repository.import was allowed, not denied",
      "stripe.product.import was held for finance, not denied",
      "github.repository.import was allowed, not held",
      "stripe.product.import was held for finance, not marketing-lead",
    ]);
    const clean = scenario("A repository and a product as declared");
    expect(
      against(
        clean,
        [
          { declared: "resources/identity/github.ts#docs", status: "drifted", field: "has_issues" },
          { declared: "resources/identity/github.ts#website", status: "clean" },
          { declared: "resources/billing/stripe.ts#pro", status: "gone" },
        ],
        await run(clean),
      ),
    ).toEqual([
      "resources/identity/github.ts#docs is clean, not drifted in has_issues",
      "resources/identity/github.ts#website is gone, not clean",
      "resources/billing/stripe.ts#pro is clean, not gone",
    ]);
  });
});

describe("a resource seed on a vendor whose fake holds no resources", () => {
  // A resource type whose fake is a plain `defineFake`, with no `override`, `put` or `remove`.
  const hook = defineResource({
    vendor: "acme",
    type: "hook",
    title: "Hook",
    identity: "name",
    schema: z.object({ name: z.string(), url: z.string().nullish() }),
    fields: { immutable: [], vendorOwned: [], writeOnly: [] },
    find: ({ name }) => name,
  });
  const acme = defineConnector("acme", { hook }, { title: "Acme", package: "@acme/connector" });
  const fake = defineFake(acme, {
    initial: () => ({}),
    ops: () => ({
      hook: {
        import: async ({ id }) => ({ id, gone: true }),
        read: async ({ id }) => ({ id, gone: true }),
      },
    }),
  });
  const ping = defineWorkflow({
    name: "ping",
    trigger: "manual",
    input: z.object({}),
    uses: [acme.hook.import],
    run: async (ctx) => ctx.acme.hook.import({ id: "deploys" }),
  });
  const dir = mkdtempSync(join(tmpdir(), "sanoma-steps-"));
  mkdirSync(join(dir, "scenarios"));
  writeFileSync(
    join(dir, "scenarios", "ping.feature"),
    `Feature: Ping\n  Scenario: Seeded\n    Given acme.hook "deploys" has\n      | url | https://example.com |\n    When ping runs\n    Then the run succeeds\n`,
  );
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const app = useApp(databaseUrl, "steps-plain", () => ({
    workflows: [ping],
    connectors: [acme],
    drivers: [fake.driver],
    fakes: [fake],
    policy: allowAll,
    scenarios: pathToFileURL(`${join(dir, "scenarios")}/`),
  }));

  it("fails the run, naming the resource and the vendor", async () => {
    const runId = await app.client.start(ping, {}, { startedBy: alice, sandbox: "Seeded" });
    const err = await failure(app.client.result(runId));
    expect(errorCode(err)).toBe("invalid_input");
    expect((err as Error).message).toBe(
      'Scenario "Seeded" seeds acme.hook, but acme\'s fake holds no resources (it is not a tfFake)',
    );
  });
});
