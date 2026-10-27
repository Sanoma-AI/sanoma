import { testDatabaseUrl } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { describe, expect, it } from "vitest";
import { type LedgerRecord, memoryLedger, resolveConfig } from "../src/index.ts";
import { check, drive, loadScenarios, type Scenario } from "../src/scenario.ts";
import { companyConfig, companyDir, companyFakes } from "./fixtures/company/fakes.ts";
import inspect from "./fixtures/company/workflows/inspect.ts";
import { rootWith } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. The company fixture's scenarios: the policy outcomes, seeded
// resources and drift results its feature files expect, on the inspect workflow, the policy
// below and the built-in drift workflow, against GitHub's and Stripe's fakes.
const databaseUrl = testDatabaseUrl("steps");
const alice = { id: "alice" };
/** The runtime's agent that runs scenarios: drift and apply run as it. */
const agent = { id: "scenarios" };

// The policy inspect.feature expects: a secret repository is never read, and a person reads a
// product once finance says so; the runtime's agents, which check drift, read without asking.
const root = rootWith(
  {
    "policies/policy.cedar": `@reason("secret repositories stay private")
forbid (principal, action == Sanoma::Action::"github.repository.import", resource)
when { context.input.id like "secret*" };

@hold("finance")
@title("Read a product")
forbid (principal, action == Sanoma::Action::"stripe.product.import", resource)
unless { principal in Sanoma::Group::"agents" };
`,
    "resources/people.ts": `import { sanoma } from "sanoma/resources";

export const alice = sanoma.person({ id: "alice" });
export const finance = sanoma.person({ id: "finance" });
`,
  },
  companyDir,
);

// The drivers are these fakes'; each sandbox run makes its own from the packages' makers.
// Unseeded: each fake holds what its replies were recorded with.
const fakes = companyFakes();
const { github, stripe } = fakes;
const config = { ...companyConfig([inspect], fakes, root), ledger: memoryLedger() };
const scope = resolveConfig(config);
const loaded = await loadScenarios(scope);
const scenario = (name: string): Scenario => loaded.scenarios.find((s) => s.name === name)!;
const passes = (s: Scenario) => s.expect.map((e) => ({ step: e.step, ok: true }));
const record = <T extends LedgerRecord["type"]>(records: LedgerRecord[], type: T, op?: string) =>
  records.find((r) => r.type === type && (op === undefined || ("op" in r && r.op === op))) as Extract<
    LedgerRecord,
    { type: T }
  >;

describe("the company's scenarios", () => {
  const app = useTestApp(config, { databaseUrl });
  // Each scenario runs once: the tests below read the ledgers of the runs `it.each` made.
  const ledgers = new Map<string, Promise<LedgerRecord[]>>();
  const run = (s: Scenario) => {
    let ledger = ledgers.get(s.name);
    if (!ledger) {
      ledger = (async () => {
        const startedBy = s.workflow === "inspect" ? alice : agent;
        const runId = await app.client.start(s.workflow!, s.input, { startedBy, sandbox: s.name });
        await drive(app.client, runId, s);
        return app.client.ledger(runId);
      })();
      ledgers.set(s.name, ledger);
    }
    return ledger;
  };

  it("all load", () => {
    expect(loaded.errors).toEqual([]);
    expect(loaded.scenarios.map((s) => [s.file, s.workflow])).toEqual([
      ["scenarios/apply.feature", "apply"],
      ["scenarios/drift.feature", "drift"],
      ["scenarios/drift.feature", "drift"],
      ["scenarios/drift.feature", "drift"],
      ["scenarios/drift.feature", "drift"],
      ["scenarios/inspect.feature", "inspect"],
      ["scenarios/inspect.feature", "inspect"],
      ["scenarios/inspect.feature", "inspect"],
      ["scenarios/inspect.feature", "inspect"],
    ]);
  });

  it.each(loaded.scenarios.map((s) => [s.name, s] as const))("%s", async (_, s) => {
    expect(await check(scope, s, await run(s))).toEqual(passes(s));
  });

  it("seeds a resource on the run's own fake, records it, and leaves the drivers' fakes as they were", async () => {
    const recorded = github.state.objects["github_repository/sanoma"];
    const edited = await run(scenario("A repository as someone edited it at GitHub"));
    expect(record(edited, "scenario.seeded").seeds).toEqual([
      { resource: "github.repository", name: "sanoma", fields: { description: "Edited at GitHub" } },
    ]);
    expect(record(edited, "op.called", "github.repository.import").output).toMatchObject({
      gone: false,
      state: { description: "Edited at GitHub" },
    });
    const gone = await run(scenario("A repository GitHub no longer has ends the inspection"));
    expect(record(gone, "scenario.seeded").seeds).toEqual([
      { resource: "github.repository", name: "sanoma", gone: true },
    ]);
    expect(record(gone, "op.called", "github.repository.import").output).toEqual({ id: "sanoma", gone: true });
    expect(gone.at(-1)).toMatchObject({ type: "run.finished", output: { repository: null, product: null } });
    expect(github.state.objects["github_repository/sanoma"]).toEqual(recorded);
    // Nothing reached the drivers' fakes: each run called its own.
    expect(github.calls).toEqual([]);
    expect(stripe.calls).toEqual([]);
  });
});
