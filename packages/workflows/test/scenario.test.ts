import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineFake, type Fake } from "../src/fake.ts";
import {
  allowAll,
  defineConnector,
  defineResource,
  defineWorkflow,
  type LedgerRecord,
  memoryLedger,
  resolveConfig,
} from "../src/index.ts";
import { missingResourceFake, seedResource } from "../src/sandbox.ts";
import {
  check as checkRun,
  type CoreExpectation,
  detailOf,
  loadScenarios,
  NOT_CHECKED,
  type Scenario,
  type Scope,
} from "../src/scenario.ts";
import announce from "./fixtures/announce.ts";
import { companyConfig } from "./fixtures/company/fakes.ts";
import inspect from "./fixtures/company/workflows/inspect.ts";
import { withFake } from "@sanoma/testing";

// The packages' connectors carry their drivers: announce's operations have one.
const scopeOf = (connectors: Parameters<typeof resolveConfig>[0]["connectors"]) => {
  const resolved = resolveConfig({
    workflows: [announce],
    connectors,
    policy: allowAll,
    ledger: memoryLedger(),
  });
  return resolved satisfies Scope;
};
const scope = scopeOf([ghost, resend, bluesky]);

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** The scenarios of one feature file with this text, compiled from a directory of its own; throws the file's error. */
async function parseFeature(text: string, file: string, s: Scope): Promise<Scenario[]> {
  const dir = mkdtempSync(join(tmpdir(), "sanoma-feature-"));
  dirs.push(dir);
  writeFileSync(join(dir, file), text);
  const { scenarios, errors } = await loadScenarios({ ...s, scenarios: pathToFileURL(`${dir}/`) });
  if (errors.length) throw new Error(errors.map((e) => e.message).join("\n"));
  return scenarios;
}
const parse = (text: string, file = "announce.feature") => parseFeature(text, file, scope);
/** What compiling throws, as its message. */
const thrown = async (text: string, s: Scope = scope) => {
  try {
    await parseFeature(text, "x.feature", s);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected parseFeature to throw");
};

/** Each expectation of the scenario checked against the records, as its `Then` step checks it. */
const check = (s: Scenario, records: readonly LedgerRecord[]) =>
  s.expect.map((e) => {
    const detail = detailOf(e as CoreExpectation, records);
    return detail === undefined ? { step: e.step, ok: true } : { step: e.step, ok: false, detail };
  });

/** A feature with one scenario that runs tally with these table rows. */
const tallyWith = (rows: string) => `Feature: T\n  Scenario: S\n    When tally runs with\n${rows}`;

/** A feature with one scenario that runs announce on made-up input. */
const feature = (name: string) => `Feature: Announce\n  Scenario: ${name}\n    When announce runs\n`;

/** A feature with one scenario that runs drift after these steps. */
const drifting = (steps: string) => `Feature: A\n  Scenario: S\n${steps}    When drift runs\n`;

/** A scenario with these expectations and nothing else. */
const expecting = (expectations: Scenario["expect"]): Scenario => ({
  name: "S",
  file: "s.feature",
  line: 1,
  workflow: "announce",
  text: "",
  steps: [],
  given: [],
  input: {},
  decisions: [],
  approvals: [],
  expect: expectations,
});

const LAUNCH = `Feature: Announce

  Scenario: Launch on time
    Given a post titled "Old news" exists
    And bluesky.post.create fails once
    When announce runs with
      """
      { "title": "Acme Pro", "launchAt": "2030-01-01T09:00:00Z" }
      """
    And "Review launch copy" is approved by marketing-lead with note "ship it"
    Then a post titled "Acme Pro" is created
    And ghost.post.publish was called
    And resend.broadcast.send was called with
      """
      { "id": "bc_0001" }
      """
    And "Acme Pro https://blog.example.test/acme-pro/" is posted to Bluesky
    And ghost.post.create was not called
    But the run succeeds
`;

describe("parseFeature", () => {
  it("gives each scenario its own lines of the file as its text, tables and examples included", async () => {
    const [tabled, second, outline] = await parse(`Feature: Announce
  Some words about it.

  Scenario: Tabled
    When announce runs with
      | title    | Acme                 |
      | launchAt | 2030-01-01T09:00:00Z |

  # Between them.
  Scenario: Second
    When announce runs

  Scenario Outline: Launch <title>
    When announce runs with
      | title | <title> |

    Examples:
      | title |
      | A     |
`);
    expect(tabled!.text).toBe(
      "Scenario: Tabled\n  When announce runs with\n    | title    | Acme                 |\n    | launchAt | 2030-01-01T09:00:00Z |",
    );
    expect(tabled!.text).not.toContain("Second");
    expect(second!.text).toBe("Scenario: Second\n  When announce runs");
    expect(outline).toMatchObject({
      name: "Launch A",
      text: "Scenario Outline: Launch <title>\n  When announce runs with\n    | title | <title> |\n\n  Examples:\n    | title |\n    | A     |",
    });
  });

  it("reads the generic steps and the connectors' phrases into a scenario", async () => {
    const [scenario, ...rest] = await parse(LAUNCH);
    expect(rest).toEqual([]);
    expect(scenario).toMatchObject({
      name: "Launch on time",
      file: "announce.feature",
      workflow: "announce",
      // Its own lines, from its keyword on, less their indent.
      text: LAUNCH.slice(LAUNCH.indexOf("Scenario:")).trimEnd().replaceAll("\n  ", "\n"),
      given: [
        {
          step: 'a post titled "Old news" exists',
          op: "ghost.post.create",
          input: { title: "Old news", html: expect.any(String), status: "draft" },
        },
        { step: "bluesky.post.create fails once", op: "bluesky.post.create", fault: "failNext" },
      ],
      input: { title: "Acme Pro", launchAt: "2030-01-01T09:00:00Z", body: expect.any(String) },
      decisions: [
        {
          step: '"Review launch copy" is approved by marketing-lead with note "ship it"',
          approval: "Review launch copy",
          decision: "approve",
          by: "marketing-lead",
          note: "ship it",
        },
      ],
      expect: [
        { op: "ghost.post.create", input: { title: "Acme Pro" }, called: true },
        { op: "ghost.post.publish", called: true },
        { op: "resend.broadcast.send", input: { id: "bc_0001" }, called: true },
        { op: "bluesky.post.create", input: { text: "Acme Pro https://blog.example.test/acme-pro/" }, called: true },
        { op: "ghost.post.create", called: false },
        { step: "the run succeeds", outcome: "finished" },
      ],
    });
    // The approvals announce's code asks for, which drive never decides by position.
    expect(scenario?.approvals).toEqual(["Review launch copy"]);
    // Plain JSON.
    expect(JSON.parse(JSON.stringify(scenario))).toEqual(scenario);
    // A step with no input expects any call.
    expect(scenario!.expect[1]).not.toHaveProperty("input");
    // `And` after `When` is a When step: here, a decision.
    // A `Then` about an operation says whether it expects a call or none.
    expect(scenario!.steps.map((s) => [s.kind, s.op, s.called])).toEqual([
      ["given", "ghost.post.create", undefined],
      ["given", "bluesky.post.create", undefined],
      ["when", undefined, undefined],
      ["when", undefined, undefined],
      ["then", "ghost.post.create", true],
      ["then", "ghost.post.publish", true],
      ["then", "resend.broadcast.send", true],
      ["then", "bluesky.post.create", true],
      ["then", "ghost.post.create", false],
      ["then", undefined, undefined],
    ]);
    // A Given that injects a fault says so; one that seeds does not.
    expect(scenario!.steps[1]).toEqual({
      text: "bluesky.post.create fails once",
      kind: "given",
      op: "bluesky.post.create",
      fault: true,
    });
    expect(scenario!.steps[0]).not.toHaveProperty("fault");
  });

  it("reads a workflow's input from a two-column table", async () => {
    const [scenario] = await parse(`Feature: Announce
  Scenario: Table
    When announce runs with
      | title    | Table launch         |
      | launchAt | 2030-01-01T09:00:00Z |
      | audience | vip                  |
    Then "Table launch" is rejected by marketing-lead
    And the run fails with "approval_rejected"
`);
    expect(scenario?.input).toMatchObject({ title: "Table launch", launchAt: "2030-01-01T09:00:00Z", audience: "vip" });
    expect(scenario?.decisions).toEqual([
      {
        step: '"Table launch" is rejected by marketing-lead',
        approval: "Table launch",
        decision: "reject",
        by: "marketing-lead",
      },
    ]);
    expect(scenario?.expect).toEqual([
      { step: 'the run fails with "approval_rejected"', outcome: "failed", code: "approval_rejected" },
    ]);
  });

  it("makes up the same complete input for one scenario name, every time", async () => {
    const [once] = await parse(feature("Made up"));
    const [again] = await parse(feature("Made up"));
    const [other] = await parse(feature("Made up too"));
    expect(once?.input).toEqual(again?.input);
    expect(once?.input).not.toEqual(other?.input);
    expect(announce.input.safeParse(once?.input).success).toBe(true);
    expect(Object.keys(once?.input as object).toSorted()).toEqual(["audience", "body", "launchAt", "title"]);
  });

  it("makes one scenario per row of a Scenario Outline's examples", async () => {
    const scenarios = await parse(`Feature: Announce
  Scenario Outline: Launch <title>
    When announce runs with
      """
      { "title": "<title>" }
      """
    Then a post titled "<title>" is created

    Examples:
      | title |
      | One   |
      | Two   |
`);
    expect(scenarios.map((s) => [s.name, (s.input as { title: string }).title])).toEqual([
      ["Launch One", "One"],
      ["Launch Two", "Two"],
    ]);
  });

  it("tells apart the rows of a Scenario Outline whose names are the same by their line", async () => {
    const scenarios = await parse(`Feature: Announce
  Scenario Outline: Launch
    When announce runs with
      | title | <title> |

    Examples:
      | title |
      | One   |
      | Two   |
`);
    expect(scenarios.map((s) => s.name)).toEqual(["Launch (line 8)", "Launch (line 9)"]);
  });

  it("reads a seed and an expected call from a two-column table, as from a doc string", async () => {
    const [scenario] = await parse(`Feature: Announce
  Scenario: Tables
    Given ghost.post.create was called with
      | title | Old news |
    When announce runs
    Then resend.broadcast.send was called with
      | id | bc_0001 |
`);
    expect(scenario?.given).toMatchObject([{ op: "ghost.post.create", input: { title: "Old news", status: "draft" } }]);
    expect(scenario?.expect).toEqual([
      {
        step: "resend.broadcast.send was called with",
        op: "resend.broadcast.send",
        input: { id: "bc_0001" },
        called: true,
      },
    ]);
  });

  it("refuses a feature file with no scenarios", async () => {
    expect(await thrown("Feature: Empty\n")).toBe('x.feature: no scenarios; add one with "Scenario: <name>"');
  });

  it("names the file and line of a step nothing matches, and lists the steps it knows, phrases under their operation", async () => {
    const message = await thrown(`Feature: Announce
  Scenario: Moon
    When announce runs
    Then the moon is out
`);
    expect(message).toMatch(/^x\.feature:4: no step matches "the moon is out"\nKnown steps:\n/);
    expect(message).toContain("  Given {op} was called with (and a JSON doc string or a two-column table)\n");
    expect(message).toContain("  When {workflow} runs\n");
    expect(message).toContain(
      "  ghost.post.create:\n    Given a post titled {title} exists\n    Then a post titled {title} is created\n",
    );
    expect(message).toContain("  bluesky.post.create:\n    Then {text} is posted to Bluesky");
  });

  it("names an unknown operation or workflow, and the ones the config has", async () => {
    expect(
      await thrown(`Feature: A\n  Scenario: S\n    Given ghost.post.burn fails once\n    When announce runs\n`),
    ).toMatch(
      /^x\.feature:3: no operation "ghost\.post\.burn"; the config has bluesky\.post\.create, ghost\.post\.create, /,
    );
    expect(await thrown(`Feature: A\n  Scenario: S\n    When refund runs\n`)).toBe(
      'x.feature:3: no workflow "refund"; the config has announce',
    );
  });

  it("refuses a step two rules match", async () => {
    const flaky = defineConnector("flaky", {
      thing: {
        poke: {
          effect: "write",
          input: z.object({ id: z.string() }),
          output: z.object({}),
          phrases: { given: "{id} fails once" },
        },
      },
    });
    const message = await thrown(
      `Feature: A\n  Scenario: S\n    Given ghost.post.publish fails once\n    When announce runs\n`,
      scopeOf([ghost, resend, bluesky, flaky]),
    );
    expect(message).toBe(
      'x.feature:3: "ghost.post.publish fails once" is ambiguous: it matches "{op} fails once" and "{id} fails once"',
    );
  });

  describe("values", () => {
    /** A workflow with a field of each kind a table cell may give. */
    const tally = defineWorkflow({
      name: "tally",
      trigger: "manual",
      input: z.object({ title: z.string(), count: z.number(), loud: z.boolean(), tags: z.array(z.string()) }),
      uses: [],
      run: async () => null,
    });
    const tallyScope = { ...scope, workflows: new Map([["tally", tally]]) };

    it("takes a cell as text when its field takes text, else as JSON", async () => {
      const [scenario] = await parseFeature(
        tallyWith(`      | title | 123 |\n      | count | 5 |\n      | loud | true |\n      | tags | ["a", "b"] |\n`),
        "x.feature",
        tallyScope,
      );
      expect(scenario?.input).toEqual({ title: "123", count: 5, loud: true, tags: ["a", "b"] });
    });

    it("refuses a value its field does not take, naming the field", async () => {
      expect(await thrown(tallyWith(`      | loud | yes |\n`), tallyScope)).toMatch(
        /^x\.feature:3: loud in tally's input cannot be "yes": /,
      );
      expect(await thrown(tallyWith(`      | count | many |\n`), tallyScope)).toMatch(
        /^x\.feature:3: count in tally's input cannot be "many": /,
      );
    });

    it("refuses a field the input does not have, in a table and in a doc string, naming those it has", async () => {
      expect(await thrown(tallyWith(`      | titel | Launch |\n`), tallyScope)).toBe(
        'x.feature:3: no field "titel" in tally\'s input; it has title, count, loud, tags',
      );
      expect(
        await thrown(`Feature: A
  Scenario: S
    When announce runs
    Then ghost.post.create was called with
      """
      { "titel": "Launch" }
      """
`),
      ).toBe('x.feature:4: no field "titel" in ghost.post.create\'s input; it has title, html, status');
    });

    it("checks each field of a doc string against its schema", async () => {
      expect(
        await thrown(`Feature: A
  Scenario: S
    Given ghost.post.create was called with
      """
      { "title": 7 }
      """
    When announce runs
`),
      ).toMatch(/^x\.feature:3: title in ghost\.post\.create's input cannot be 7: /);
    });

    it("reads a phrase's field as its own type, even one named like a built-in type", async () => {
      const runs = defineConnector("runs", {
        run: {
          start: {
            effect: "write",
            input: z.object({ workflow: z.string(), int: z.number() }),
            output: z.object({}),
            phrases: { given: "a run of {workflow} with {int} tries exists" },
          },
        },
      });
      const [scenario] = await parseFeature(
        `Feature: A\n  Scenario: S\n    Given a run of "refund all" with 3 tries exists\n    When announce runs\n`,
        "x.feature",
        scopeOf([ghost, resend, bluesky, runs]),
      );
      expect(scenario?.given).toEqual([
        {
          step: 'a run of "refund all" with 3 tries exists',
          op: "runs.run.start",
          input: { workflow: "refund all", int: 3 },
        },
      ]);
    });
  });

  it("refuses a phrase naming a field its operation's input does not have", async () => {
    const odd = defineConnector("odd", {
      thing: {
        poke: {
          effect: "write",
          input: z.object({ id: z.string() }),
          output: z.object({}),
          phrases: { given: "{nope} poked" },
        },
      },
    });
    await expect(parseFeature("Feature: A\n", "x.feature", scopeOf([ghost, resend, bluesky, odd]))).rejects.toThrow(
      'odd.thing.poke: its given phrase "{nope} poked" names {nope}, which is not a field of its input',
    );
  });

  it("refuses a scenario with no When, a second When, and a doc string that is not JSON", async () => {
    expect(await thrown(`Feature: A\n  Scenario: Idle\n    Then the run succeeds\n`)).toMatch(
      /^x\.feature:2: scenario "Idle" has no When/,
    );
    expect(await thrown(`Feature: A\n  Scenario: Twice\n    When announce runs\n    And announce runs\n`)).toBe(
      "x.feature:4: a second When: a scenario runs its workflow once",
    );
    expect(
      await thrown(
        `Feature: A\n  Scenario: Bad\n    When announce runs with\n      """\n      { title: 1 }\n      """\n`,
      ),
    ).toMatch(/^x\.feature:3: the doc string after "announce runs with" is not JSON: /);
  });
});

describe("loadScenarios", () => {
  const dir = mkdtempSync(join(tmpdir(), "sanoma-scenarios-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("loads every feature file, and refuses a name used twice across files", async () => {
    writeFileSync(join(dir, "a.feature"), feature("Same"));
    writeFileSync(join(dir, "b.feature"), `${feature("Same")}\n  Scenario: Other\n    When announce runs\n`);
    writeFileSync(join(dir, "c.feature"), "Feature: A\n  Scenario: Broken\n    Then nothing\n");
    const { scenarios, errors } = await loadScenarios({ ...scope, scenarios: pathToFileURL(`${dir}/`) });
    expect(scenarios.map((s) => [s.file, s.name])).toEqual([
      ["a.feature", "Same"],
      ["b.feature", "Other"],
    ]);
    expect(errors).toEqual([
      { file: "b.feature", message: 'b.feature: scenario "Same" is also in a.feature; give each its own name' },
      { file: "c.feature", message: expect.stringMatching(/^c\.feature:3: no step matches "nothing"/) },
    ]);
  });

  it("compiles the files again only once one has changed", async () => {
    const sub = join(dir, "cached");
    mkdirSync(sub);
    writeFileSync(join(sub, "a.feature"), feature("First"));
    const cachedScope = { ...scope, scenarios: pathToFileURL(`${sub}/`) };
    const first = await loadScenarios(cachedScope);
    expect(await loadScenarios(cachedScope)).toBe(first);

    // Written again, longer, so the stamp changes even where the clock is coarse.
    writeFileSync(join(sub, "a.feature"), feature("First, renamed"));
    const second = await loadScenarios(cachedScope);
    expect(second).not.toBe(first);
    expect(second.scenarios.map((s) => s.name)).toEqual(["First, renamed"]);

    writeFileSync(join(sub, "b.feature"), feature("Second"));
    expect((await loadScenarios(cachedScope)).scenarios.map((s) => s.name)).toEqual(["First, renamed", "Second"]);
  });

  it("finds no scenarios, and no errors, without a directory", async () => {
    expect(await loadScenarios({ ...scope, scenarios: pathToFileURL(join(dir, "missing/")) })).toEqual({
      scenarios: [],
      errors: [],
    });
    expect(await loadScenarios(scope)).toEqual({ scenarios: [], errors: [] });
  });
});

describe("check", () => {
  const common = { v: 1, app: "a", runId: "r", at: 0, actor: { id: "alice" }, workflow: "announce" } as const;
  const called = (seq: number, op: string, input: unknown): LedgerRecord => ({
    ...common,
    id: `r:op.called:${seq}`,
    seq,
    type: "op.called",
    op,
    effect: "write",
    input,
    decision: { kind: "allow" },
    durationMs: 1,
  });
  /** A call that failed with `error`. */
  const attempted = (seq: number, op: string, error: Extract<LedgerRecord, { type: "op.called" }>["error"]) =>
    ({ ...called(seq, op, { id: "p1" }), error }) as LedgerRecord;
  const calls = [
    called(1, "ghost.post.create", { title: "Acme Pro", html: "<p>x</p>", status: "draft", meta: { tags: ["a"] } }),
  ];
  const finished: LedgerRecord = { ...common, id: "r:run.finished:2", seq: 2, type: "run.finished", output: {} };
  const failed: LedgerRecord = {
    ...common,
    id: "r:run.failed:2",
    seq: 2,
    type: "run.failed",
    error: { code: "approval_rejected", name: "RejectedError", message: "no" },
  };

  it("matches an operation's input as a subset, at every depth", async () => {
    const checks = check(
      expecting([
        { step: "title", op: "ghost.post.create", input: { title: "Acme Pro", meta: { tags: ["a"] } }, called: true },
        { step: "other", op: "ghost.post.create", input: { title: "Other" }, called: true },
        { step: "any", op: "ghost.post.create", called: true },
        { step: "none", op: "ghost.post.publish", called: true },
      ]),
      [...calls, finished],
    );
    expect(checks).toEqual([
      { step: "title", ok: true },
      {
        step: "other",
        ok: false,
        detail: expect.stringMatching(/^no call to ghost\.post\.create with \{"title":"Other"\}; its calls had /),
      },
      { step: "any", ok: true },
      { step: "none", ok: false, detail: "no call to ghost.post.publish" },
    ]);
  });

  it("passes `was not called` only when there is no call", async () => {
    const checks = check(
      expecting([
        { step: "publish", op: "ghost.post.publish", called: false },
        { step: "create", op: "ghost.post.create", called: false },
      ]),
      calls,
    );
    expect(checks).toEqual([
      { step: "publish", ok: true },
      {
        step: "create",
        ok: false,
        detail:
          'ghost.post.create was called with {"title":"Acme Pro","html":"<p>x</p>","status":"draft","meta":{"tags":["a"]}}',
      },
    ]);
  });

  it("counts a call that failed (denied, rejected, or failed at the vendor) as attempted, not made", async () => {
    const records = [
      attempted(1, "ghost.post.publish", { code: "policy_denied", name: "PolicyDeniedError", message: "not today" }),
      attempted(2, "resend.broadcast.send", {
        code: "approval_rejected",
        name: "RejectedError",
        message: '"Send" was rejected by boss',
      }),
      attempted(3, "bluesky.post.create", { code: "driver_failed", name: "DriverError", message: "down" }),
    ];
    const checks = check(
      expecting([
        { step: "publish", op: "ghost.post.publish", called: true },
        { step: "send", op: "resend.broadcast.send", input: { id: "p1" }, called: true },
        { step: "post", op: "bluesky.post.create", called: true },
        { step: "not published", op: "ghost.post.publish", called: false },
      ]),
      records,
    );
    expect(checks).toEqual([
      { step: "publish", ok: false, detail: "no call to ghost.post.publish; attempted: policy_denied: not today" },
      {
        step: "send",
        ok: false,
        detail:
          'no call to resend.broadcast.send with {"id":"p1"}; attempted: approval_rejected: "Send" was rejected by boss',
      },
      { step: "post", ok: false, detail: "no call to bluesky.post.create; attempted: driver_failed: down" },
      { step: "not published", ok: true },
    ]);
  });

  it("reads the outcome from the run's last record: finished, failed with a code, or not ended", async () => {
    const outcomes = expecting([
      { step: "succeeds", outcome: "finished" },
      { step: "fails", outcome: "failed" },
      { step: "rejected", outcome: "failed", code: "approval_rejected" },
      { step: "denied", outcome: "failed", code: "policy_denied" },
    ]);
    expect(check(outcomes, [...calls, finished]).map((c) => c.ok)).toEqual([true, false, false, false]);
    expect(check(outcomes, [...calls, failed])).toEqual([
      { step: "succeeds", ok: false, detail: "the run failed: no" },
      { step: "fails", ok: true },
      { step: "rejected", ok: true },
      { step: "denied", ok: false, detail: "the run failed with approval_rejected: no" },
    ]);
    expect(check(outcomes, calls).map((c) => c.detail)).toEqual(Array(4).fill("run not ended"));
  });
});

/** One fake of each vendor, from its maker, as a sandbox run makes them. */
const made = (fakes: ReadonlyMap<string, () => Fake<any, any>>) =>
  new Map([...fakes].map(([vendor, make]) => [vendor, make()]));

describe("resources and policy outcomes", () => {
  // The company fixture's connectors, which declare resource types, its fakes and its inspect workflow.
  const company = resolveConfig({ ...companyConfig([inspect], allowAll), ledger: memoryLedger() });
  const parseCompany = (text: string) => parseFeature(text, "company.feature", company);
  const DRIFT = `Feature: Drift

  Scenario: Changed at GitHub
    Given github.repository "website" has
      | name     | website              |
      | has_wiki | true                 |
      | topics   | ["website", "astro"] |
    And github.repository "docs" is gone
    When drift runs
    Then resources/identity/github.ts#website is drifted in has_wiki
    And resources/identity/github.ts#docs is gone
    And resources/billing/stripe.ts#pro is clean
`;
  const INSPECT = `Feature: Inspect

  Scenario: Refused and held
    When inspect runs
    And "Read a product" is approved by finance
    Then github.repository.import was denied
    And stripe.product.import was held for finance
`;

  it("reads a resource to put or remove, a drift result, and a denial or a hold into a scenario", async () => {
    const [drift] = await parseCompany(DRIFT);
    expect(drift).toMatchObject({
      workflow: "drift",
      given: [
        {
          step: 'github.repository "website" has',
          resource: "github.repository",
          vendor: "github",
          type: "repository",
          name: "website",
          // Text where the field takes it, else JSON, as a table gives an operation's input.
          fields: { name: "website", has_wiki: true, topics: ["website", "astro"] },
        },
        {
          step: 'github.repository "docs" is gone',
          resource: "github.repository",
          vendor: "github",
          type: "repository",
          name: "docs",
          gone: true,
        },
      ],
      expect: [
        { declared: "resources/identity/github.ts#website", status: "drifted", field: "has_wiki" },
        { declared: "resources/identity/github.ts#docs", status: "gone" },
        { declared: "resources/billing/stripe.ts#pro", status: "clean" },
      ],
    });
    // A step about a resource names no operation.
    expect(drift!.steps.map((s) => s.op)).toEqual(Array(6).fill(undefined));

    const [held] = await parseCompany(INSPECT);
    expect(held).toMatchObject({
      workflow: "inspect",
      expect: [
        { step: "github.repository.import was denied", op: "github.repository.import", decision: "denied" },
        {
          step: "stripe.product.import was held for finance",
          op: "stripe.product.import",
          decision: "held",
          approver: "finance",
        },
      ],
    });
    // A policy outcome is about its operation, and neither expects a call nor rules one out.
    expect(held!.steps.slice(2)).toEqual([
      { text: "github.repository.import was denied", kind: "then", op: "github.repository.import", decision: "denied" },
      {
        text: "stripe.product.import was held for finance",
        kind: "then",
        op: "stripe.product.import",
        decision: "held",
      },
    ]);
  });

  it("refuses a resource seed of a vendor whose fake holds no resources", async () => {
    const [drift] = await parseCompany(DRIFT);
    expect(missingResourceFake(drift!, made(company.fakes))).toBeUndefined();
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
    const ops = {
      hook: { import: async () => ({ id: "x", gone: true }), read: async () => ({ id: "x", gone: true }) },
    };
    const plain = defineFake(acme, { initial: () => ({}), ops: () => ops });
    const ping = defineWorkflow({
      name: "ping",
      trigger: "manual",
      input: z.object({}),
      uses: [acme.hook.import],
      run: async (ctx) => ctx.acme.hook.import({ id: "deploys" }),
    });
    const resolved = resolveConfig({
      workflows: [ping],
      connectors: [withFake(acme, plain)],
      policy: allowAll,
      ledger: memoryLedger(),
    });
    const [seeded] = await parseFeature(
      `Feature: Ping\n  Scenario: Seeded\n    Given acme.hook "deploys" has\n      | url | https://example.com |\n    And acme.hook "other" is gone\n    When ping runs\n`,
      "ping.feature",
      resolved,
    );
    const problem = missingResourceFake(seeded!, made(resolved.fakes));
    expect(problem?.code).toBe("invalid_input");
    expect(problem?.message).toBe(
      'Scenario "Seeded" seeds acme.hook, but acme\'s fake holds no resources (it is not a tfFake)',
    );
    expect(problem?.data).toEqual({ scenario: "Seeded", resources: ["acme.hook"] });
    // A vendor whose connector attaches no fake is refused, saying so.
    expect(missingResourceFake(seeded!, new Map())?.message).toBe(
      'Scenario "Seeded" seeds acme.hook, but acme\'s connector attaches no fake',
    );
  });

  it("seeds a resource on the copy as the step says, and fails the scenario, naming the step, when the fake refuses it", async () => {
    const [drift] = await parseCompany(DRIFT);
    const [has, gone] = drift!.given as Extract<Scenario["given"][number], { resource: string }>[];
    const done: unknown[] = [];
    const copy = {
      override: () => {},
      put: (...args: unknown[]) => void done.push(["put", ...args]),
      remove: (...args: unknown[]) => void done.push(["remove", ...args]),
    };
    expect(seedResource("S", copy, has!)).toEqual({
      resource: "github.repository",
      name: "website",
      fields: { name: "website", has_wiki: true, topics: ["website", "astro"] },
    });
    expect(seedResource("S", copy, gone!)).toEqual({ resource: "github.repository", name: "docs", gone: true });
    expect(done).toEqual([
      ["put", "repository", "website", { name: "website", has_wiki: true, topics: ["website", "astro"] }],
      ["remove", "repository", "docs"],
    ]);
    const refusing = {
      ...copy,
      put: () => {
        throw new Error("fake github: repository has no field has_wiki");
      },
    };
    let err: unknown;
    try {
      seedResource("S", refusing, has!);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: "invalid_input",
      message:
        'Scenario "S" cannot seed github.repository "website" ("github.repository "website" has"): fake github: repository has no field has_wiki',
      data: { scenario: "S", step: 'github.repository "website" has', resource: "github.repository", name: "website" },
    });
  });

  it("names an unknown resource type, field or value, and a drift result in a scenario that does not run drift", async () => {
    expect(await thrown(drifting('    Given github.gist "x" is gone\n'), company)).toBe(
      'x.feature:3: no resource type "github.gist"; the config has github.branch_protection, github.repository, github.team_membership, stripe.product, stripe.webhook_endpoint',
    );
    expect(await thrown(drifting('    Given github.repository "x" has\n      | nope | 1 |\n'), company)).toMatch(
      /^x\.feature:3: no field "nope" in github\.repository "x"; it has allow_auto_merge, /,
    );
    expect(await thrown(drifting('    Given github.repository "x" has\n      | has_wiki | yes |\n'), company)).toMatch(
      /^x\.feature:3: has_wiki in github\.repository "x" cannot be "yes": /,
    );
    expect(
      await thrown(
        `Feature: A\n  Scenario: S\n    When inspect runs\n    Then resources/identity/github.ts#website is clean\n`,
        company,
      ),
    ).toBe(
      'x.feature:2: "resources/identity/github.ts#website is clean" reads a drift report, so the scenario must run drift, not inspect',
    );
  });

  describe("check", () => {
    const common = { v: 1, app: "a", runId: "r", at: 0, actor: { id: "alice" }, workflow: "inspect" } as const;
    const decided = (
      seq: number,
      op: string,
      decision: Extract<LedgerRecord, { type: "op.called" }>["decision"],
    ): LedgerRecord => ({
      ...common,
      id: `r:op.called:${seq}`,
      seq,
      type: "op.called",
      op,
      effect: "read",
      input: { id: "x" },
      decision,
      durationMs: 1,
    });
    const requested = (
      seq: number,
      request: Partial<Extract<LedgerRecord, { type: "approval.requested" }>>,
    ): LedgerRecord => ({
      ...common,
      id: `r:approval.requested:approval-${seq}`,
      seq,
      type: "approval.requested",
      approval: `approval-${seq}`,
      title: "Read a product",
      approver: "finance",
      requestedBy: "policy",
      covers: [],
      ...request,
    });
    const records = [
      decided(1, "github.repository.import", { kind: "allow" }),
      requested(2, { op: "stripe.product.import", covers: ["stripe.product.import"] }),
      decided(3, "stripe.product.import", { kind: "approve", approver: "finance" }),
      decided(4, "github.branch_protection.import", { kind: "deny", reason: "no rules" }),
      // The workflow's own approval, to a group, covering an operation.
      requested(5, {
        title: "Publish",
        approver: { group: "editors" },
        requestedBy: "workflow",
        covers: ["ghost.post.publish"],
      }),
    ];
    const details = (expectations: Scenario["expect"], over = records) =>
      check(expecting(expectations), over).map((c) => c.detail);
    const ended = (end: LedgerRecord) => [...records, end];

    it("passes a denial and a hold, and says what the policy decided instead", async () => {
      expect(
        details([
          { step: "denied", op: "github.branch_protection.import", decision: "denied" },
          { step: "allowed", op: "github.repository.import", decision: "denied" },
          { step: "held", op: "stripe.product.import", decision: "denied" },
          { step: "never called", op: "stripe.webhook_endpoint.import", decision: "denied" },
        ]),
      ).toEqual([
        undefined,
        "github.repository.import was allowed, not denied",
        "stripe.product.import was held for finance, not denied",
        "no call to stripe.webhook_endpoint.import",
      ]);
      expect(
        details([
          { step: "held", op: "stripe.product.import", decision: "held", approver: "finance" },
          { step: "covered, group by name", op: "ghost.post.publish", decision: "held", approver: "editors" },
          { step: "other approver", op: "stripe.product.import", decision: "held", approver: "marketing-lead" },
          { step: "allowed", op: "github.repository.import", decision: "held", approver: "finance" },
          { step: "denied", op: "github.branch_protection.import", decision: "held", approver: "finance" },
          { step: "never called", op: "stripe.webhook_endpoint.import", decision: "held", approver: "finance" },
        ]),
      ).toEqual([
        undefined,
        undefined,
        "stripe.product.import was held for finance, not marketing-lead",
        "github.repository.import was allowed, not held",
        "github.branch_protection.import was denied, not held",
        "no call to stripe.webhook_endpoint.import",
      ]);
    });

    it("reads a drift result from the report the run returned, and says how the resource was found instead", async () => {
      const report = {
        startedAt: 0,
        finishedAt: 1,
        problems: [],
        resources: [
          {
            id: "resources/identity/github.ts#website",
            vendor: "github",
            type: "repository",
            name: "website",
            status: "drifted",
            fields: [
              { path: "has_wiki", desired: false, actual: true },
              { path: "topics", desired: ["a"], actual: ["b"] },
            ],
          },
          {
            id: "resources/identity/github.ts#docs",
            vendor: "github",
            type: "repository",
            name: "docs",
            status: "clean",
            fields: [],
          },
          {
            id: "resources/identity/rules.ts#docsMain",
            vendor: "github",
            type: "branch_protection",
            name: "docs:main",
            status: "gone",
            fields: [],
          },
          {
            id: "resources/billing/stripe.ts#pro",
            vendor: "stripe",
            type: "product",
            name: "pro",
            status: "error",
            fields: [],
            error: "denied by policy: no Stripe",
          },
        ],
      };
      const finished = (output: unknown): LedgerRecord => ({
        ...common,
        id: "r:run.finished:9",
        seq: 9,
        type: "run.finished",
        output,
      });
      const website = "resources/identity/github.ts#website";
      const results: Scenario["expect"] = [
        { step: "drifted", declared: website, status: "drifted", field: "has_wiki" },
        { step: "other field", declared: website, status: "drifted", field: "name" },
        { step: "clean", declared: website, status: "clean" },
        { step: "gone", declared: "resources/identity/github.ts#docs", status: "gone" },
        { step: "clean", declared: "resources/identity/rules.ts#docsMain", status: "clean" },
        { step: "unread", declared: "resources/billing/stripe.ts#pro", status: "clean" },
        { step: "unknown", declared: "resources/x.ts#y", status: "clean" },
      ];
      expect(details(results, ended(finished(report)))).toEqual([
        undefined,
        `${website} is drifted in has_wiki, topics, not drifted in name`,
        `${website} is drifted in has_wiki, topics, not clean`,
        "resources/identity/github.ts#docs is clean, not gone",
        "resources/identity/rules.ts#docsMain is gone, not clean",
        "resources/billing/stripe.ts#pro could not be read: denied by policy: no Stripe",
        "no resource resources/x.ts#y in the report; it has resources/identity/github.ts#website, resources/identity/github.ts#docs, resources/identity/rules.ts#docsMain, resources/billing/stripe.ts#pro",
      ]);
      expect(details(results.slice(0, 1), ended(finished({})))).toEqual(["the run's output is not a drift report"]);
      const failed: LedgerRecord = {
        ...common,
        id: "r:run.failed:9",
        seq: 9,
        type: "run.failed",
        error: { name: "Error", message: "no" },
      };
      expect(details(results.slice(0, 1), ended(failed))).toEqual(["the run failed: no"]);
      expect(details(results.slice(0, 1))).toEqual(["run not ended"]);
    });
  });
});

/** Compiles the text as `file` in a directory of its own, and returns that directory's scope with its scenarios. */
async function compiled(text: string, s: Scope = scope, file = "x.feature") {
  const dir = mkdtempSync(join(tmpdir(), "sanoma-cucumber-"));
  dirs.push(dir);
  writeFileSync(join(dir, file), text);
  const within = { ...s, scenarios: pathToFileURL(`${dir}/`) };
  return { scope: within, ...(await loadScenarios(within)) };
}

describe("Cucumber", () => {
  it("builds its library again in one process: another config compiles the same scenarios", async () => {
    const first = await compiled(LAUNCH);
    // A config resolved again has its own operations, so its library is built anew.
    const again = await compiled(LAUNCH, scopeOf([ghost, resend, bluesky]));
    expect(again.scope.ops).not.toBe(first.scope.ops);
    expect(first.errors).toEqual([]);
    expect(first.scenarios).toHaveLength(1);
    expect(again.scenarios).toEqual(first.scenarios);
  });

  it("names the file and line of a step no step matches, of one two steps match, and of a file Gherkin cannot parse", async () => {
    expect(await thrown(`Feature: A\n  Scenario: S\n    When announce runs\n    Then the sky is green\n`)).toMatch(
      /^x\.feature:4: no step matches "the sky is green"\nKnown steps:\n/,
    );
    const flaky = defineConnector("flaky", {
      thing: {
        poke: {
          effect: "write",
          input: z.object({ id: z.string() }),
          output: z.object({}),
          phrases: { given: "{id} is rate limited once" },
        },
      },
    });
    expect(
      await thrown(
        `Feature: A\n  Scenario: S\n    When announce runs\n    Given ghost.post.publish is rate limited once\n`,
        scopeOf([ghost, resend, bluesky, flaky]),
      ),
    ).toBe(
      'x.feature:4: "ghost.post.publish is rate limited once" is ambiguous: it matches "{op} is rate limited once" and "{id} is rate limited once"',
    );
    expect(await thrown(`Feature: A\n  Scenario: S\n    When announce runs\n  Feature: B\n`)).toMatch(
      /^x\.feature:4: \(4:3\): expected: /,
    );
    // A file that does not parse is left out; the others still compile.
    const dir = mkdtempSync(join(tmpdir(), "sanoma-cucumber-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.feature"), "Feature: A\n  Scenario: S\n    When announce runs\n  Feature: B\n");
    writeFileSync(join(dir, "b.feature"), feature("Fine"));
    const both = await loadScenarios({ ...scope, scenarios: pathToFileURL(`${dir}/`) });
    expect(both.scenarios.map((s) => s.name)).toEqual(["Fine"]);
    expect(both.errors.map((e) => e.file)).toEqual(["a.feature"]);
  });

  it("compiles a config's feature files in well under 50 ms once Cucumber is loaded, its library built anew", async () => {
    await compiled(LAUNCH);
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const fresh = scopeOf([ghost, resend, bluesky]);
      const dir = mkdtempSync(join(tmpdir(), "sanoma-cucumber-"));
      dirs.push(dir);
      writeFileSync(join(dir, "announce.feature"), LAUNCH);
      writeFileSync(
        join(dir, "compose.feature"),
        readFileSync(new URL("./fixtures/scenarios/compose.feature", import.meta.url)),
      );
      const started = performance.now();
      const { errors } = await loadScenarios({ ...fresh, scenarios: pathToFileURL(`${dir}/`) });
      times.push(performance.now() - started);
      expect(errors).toEqual([]);
    }
    expect(times.toSorted((a, b) => a - b)[2]).toBeLessThan(50);
  });

  it("reads the connectors' steps: a seed named for an operation's own test, and a Then of the connector's own", async () => {
    const text = readFileSync(new URL("./fixtures/scenarios/compose.feature", import.meta.url), "utf8");
    const [scenario] = await parse(text, "compose.feature");
    expect(scenario?.given).toMatchObject([
      { step: 'a Ghost draft titled "Old news"', op: "ghost.post.create", input: { title: "Old news" }, as: "draft" },
      { step: "Resend fails to send once", op: "resend.broadcast.send", fault: "failNext" },
    ]);
    expect(scenario?.expect).toEqual([
      { step: 'the Ghost post "Acme Pro" is published', owner: "ghost", op: "ghost.post.publish", called: true },
      { step: "bluesky.post.create was not called", op: "bluesky.post.create", called: false },
      { step: "the run fails", outcome: "failed" },
    ]);
    expect(scenario?.steps.map((s) => [s.kind, s.op, s.called, s.fault])).toEqual([
      ["given", "ghost.post.create", undefined, undefined],
      ["given", "resend.broadcast.send", undefined, true],
      ["when", undefined, undefined, undefined],
      ["when", undefined, undefined, undefined],
      ["then", "ghost.post.publish", true, undefined],
      ["then", "bluesky.post.create", false, undefined],
      ["then", undefined, undefined, undefined],
    ]);
  });

  it("refuses an operation's own test step in a scenario of a workflow", async () => {
    expect(
      await thrown(`Feature: A\n  Scenario: S\n    When ghost.post.publish is called with\n      | id | p |\n`),
    ).toBe(
      "x.feature:3: \"ghost.post.publish is called with\" calls ghost.post.publish directly: a step for an operation's own test, in its connector's features",
    );
  });

  describe("checking a run", () => {
    const common = { v: 1, app: "a", runId: "r", at: 0, actor: { id: "alice" }, workflow: "announce" } as const;
    const records: LedgerRecord[] = [
      {
        ...common,
        id: "r:op.called:1",
        seq: 1,
        type: "op.called",
        op: "ghost.post.create",
        effect: "write",
        input: { title: "Acme Pro", html: "x", status: "draft" },
        output: { id: "post_0002" },
        decision: { kind: "allow" },
        durationMs: 1,
      },
      { ...common, id: "r:run.finished:2", seq: 2, type: "run.finished", output: {} },
    ];

    it("runs the Then steps against the ledger, one check per expectation, in order", async () => {
      const { scope: within, scenarios } = await compiled(LAUNCH);
      const [launch] = scenarios as [Scenario];
      const checks = await checkRun(within, launch, records);
      expect(checks.map((c) => c.step)).toEqual(launch.expect.map((e) => e.step));
      expect(checks).toEqual([
        { step: 'a post titled "Acme Pro" is created', ok: true },
        { step: "ghost.post.publish was called", ok: false, detail: "no call to ghost.post.publish" },
        // Cucumber skips the steps after a failed one.
        ...launch.expect.slice(2).map((e) => ({ step: e.step, ok: false, detail: NOT_CHECKED })),
      ]);
    });

    it("checks one row of a Scenario Outline, and tells a Given from a Then that reads the same", async () => {
      const text = `Feature: A
  Scenario Outline: Launch
    Given ghost.post.create was called with
      | title | Acme Pro |
    When announce runs
    Then ghost.post.create was called with
      | title | <title> |

    Examples:
      | title    |
      | Other    |
      | Acme Pro |
`;
      const { scope: within, scenarios } = await compiled(text);
      expect(scenarios.map((s) => [s.name, s.line])).toEqual([
        ["Launch (line 11)", 11],
        ["Launch (line 12)", 12],
      ]);
      const [other, acme] = scenarios as [Scenario, Scenario];
      expect(await checkRun(within, other, records)).toEqual([
        {
          step: "ghost.post.create was called with",
          ok: false,
          detail: expect.stringMatching(/^no call to ghost\.post\.create with \{"title":"Other"\}/),
        },
      ]);
      expect(await checkRun(within, acme, records)).toEqual([{ step: "ghost.post.create was called with", ok: true }]);
    });

    it("passes a scenario whose every Then holds, and reads the feature file as it is now", async () => {
      const text = `Feature: A\n  Scenario: S\n    When announce runs\n    Then a post titled "Acme Pro" is created\n    And the run succeeds\n`;
      const { scope: within, scenarios } = await compiled(text);
      const [s] = scenarios as [Scenario];
      expect(await checkRun(within, s, records)).toEqual([
        { step: 'a post titled "Acme Pro" is created', ok: true },
        { step: "the run succeeds", ok: true },
      ]);
      // The step is gone from the file: the scenario must be loaded again.
      writeFileSync(join(fileURLToPath(within.scenarios), "x.feature"), text.replace("    And the run succeeds\n", ""));
      await expect(checkRun(within, s, records)).rejects.toThrow(
        'x.feature:2: scenario "S" no longer has the expectations it was read with',
      );
    });
  });
});
