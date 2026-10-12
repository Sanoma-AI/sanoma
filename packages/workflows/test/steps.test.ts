import { testDatabaseUrl } from "@sanoma/testing";
import { useTestApp } from "@sanoma/testing/harness";
import { describe, expect, it } from "vitest";
import { type LedgerRecord, memoryLedger, resolveConfig } from "../src/index.ts";
import { check, drive, loadScenarios, type Scenario } from "../src/scenario.ts";
import { companyConfig, companyFakes } from "./fixtures/company/fakes.ts";
import policy from "./fixtures/company/policies/policy.ts";
import inspect from "./fixtures/company/workflows/inspect.ts";

// Needs Postgres: `pnpm db:up`. The company fixture's scenarios: the policy outcomes, seeded
// resources and drift results its feature files expect, on the inspect workflow, its policy and
// the built-in drift workflow, against GitHub's and Stripe's fakes.
const databaseUrl = testDatabaseUrl("steps");
const alice = { id: "alice" };

// The connectors' fakes are the templates each sandbox run copies, and the drivers. Unseeded:
// each fake holds what its replies were recorded with.
const fakes = companyFakes();
const { github, stripe } = fakes;
const config = { ...companyConfig([inspect], policy, fakes), ledger: memoryLedger() };
const loaded = loadScenarios(resolveConfig(config));
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
        const runId = await app.client.start(s.workflow, s.input, { startedBy: alice, sandbox: s.name });
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

  it("seeds a resource on the run's copy of the fake, records it, and leaves the config's fake as it was", async () => {
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
    // Nothing reached the templates: each run called its own copies.
    expect(github.calls).toEqual([]);
    expect(stripe.calls).toEqual([]);
  });
});
