import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  allowAll,
  defineConnector,
  defineWorkflow,
  type LedgerRecord,
  memoryLedger,
  resolveConfig,
} from "../src/index.ts";
import { check, loadScenarios, parseFeature, type Scenario, type Scope } from "../src/scenario.ts";
import announce from "./fixtures/announce.ts";
import { marketingFakes } from "./harness.ts";

const scopeOf = (connectors: Parameters<typeof resolveConfig>[0]["connectors"], drivers = marketingFakes().drivers) => {
  const resolved = resolveConfig({
    workflows: [announce],
    connectors,
    drivers,
    policy: allowAll,
    ledger: memoryLedger(),
  });
  return resolved satisfies Scope;
};
const scope = scopeOf([ghost, resend, bluesky]);
const parse = (text: string, file = "announce.feature") => parseFeature(text, file, scope);
/** What parsing throws, as its message. */
const thrown = (text: string, s: Scope = scope) => {
  try {
    parseFeature(text, "x.feature", s);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected parseFeature to throw");
};

/** A feature with one scenario that runs tally with these table rows. */
const tallyWith = (rows: string) => `Feature: T\n  Scenario: S\n    When tally runs with\n${rows}`;

/** A feature with one scenario that runs announce on made-up input. */
const feature = (name: string) => `Feature: Announce\n  Scenario: ${name}\n    When announce runs\n`;

/** A scenario with these expectations and nothing else. */
const expecting = (expectations: Scenario["expect"]): Scenario => ({
  name: "S",
  file: "s.feature",
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
  it("gives each scenario its own lines of the file as its text, tables and examples included", () => {
    const [tabled, second, outline] = parse(`Feature: Announce
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

  it("reads the generic steps and the connectors' phrases into a scenario", () => {
    const [scenario, ...rest] = parse(LAUNCH);
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
    expect(scenario!.steps.map((s) => [s.kind, s.op])).toEqual([
      ["given", "ghost.post.create"],
      ["given", "bluesky.post.create"],
      ["when", undefined],
      ["when", undefined],
      ["then", "ghost.post.create"],
      ["then", "ghost.post.publish"],
      ["then", "resend.broadcast.send"],
      ["then", "bluesky.post.create"],
      ["then", "ghost.post.create"],
      ["then", undefined],
    ]);
  });

  it("reads a workflow's input from a two-column table", () => {
    const [scenario] = parse(`Feature: Announce
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

  it("makes up the same complete input for one scenario name, every time", () => {
    const [once] = parse(feature("Made up"));
    const [again] = parse(feature("Made up"));
    const [other] = parse(feature("Made up too"));
    expect(once?.input).toEqual(again?.input);
    expect(once?.input).not.toEqual(other?.input);
    expect(announce.input.safeParse(once?.input).success).toBe(true);
    expect(Object.keys(once?.input as object).toSorted()).toEqual(["audience", "body", "launchAt", "title"]);
  });

  it("makes one scenario per row of a Scenario Outline's examples", () => {
    const scenarios = parse(`Feature: Announce
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

  it("tells apart the rows of a Scenario Outline whose names are the same by their line", () => {
    const scenarios = parse(`Feature: Announce
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

  it("reads a seed and an expected call from a two-column table, as from a doc string", () => {
    const [scenario] = parse(`Feature: Announce
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

  it("refuses a feature file with no scenarios", () => {
    expect(thrown("Feature: Empty\n")).toBe('x.feature: no scenarios; add one with "Scenario: <name>"');
  });

  it("names the file and line of a step nothing matches, and lists the steps it knows, phrases under their operation", () => {
    const message = thrown(`Feature: Announce
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

  it("names an unknown operation or workflow, and the ones the config has", () => {
    expect(thrown(`Feature: A\n  Scenario: S\n    Given ghost.post.burn fails once\n    When announce runs\n`)).toMatch(
      /^x\.feature:3: no operation "ghost\.post\.burn"; the config has bluesky\.post\.create, ghost\.post\.create, /,
    );
    expect(thrown(`Feature: A\n  Scenario: S\n    When refund runs\n`)).toBe(
      'x.feature:3: no workflow "refund"; the config has announce',
    );
  });

  it("refuses a step two rules match", () => {
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
    const drivers = [...marketingFakes().drivers, { vendor: "flaky", ops: { "thing.poke": async () => ({}) } }];
    const message = thrown(
      `Feature: A\n  Scenario: S\n    Given ghost.post.publish fails once\n    When announce runs\n`,
      scopeOf([ghost, resend, bluesky, flaky], drivers),
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

    it("takes a cell as text when its field takes text, else as JSON", () => {
      const [scenario] = parseFeature(
        tallyWith(`      | title | 123 |\n      | count | 5 |\n      | loud | true |\n      | tags | ["a", "b"] |\n`),
        "x.feature",
        tallyScope,
      );
      expect(scenario?.input).toEqual({ title: "123", count: 5, loud: true, tags: ["a", "b"] });
    });

    it("refuses a value its field does not take, naming the field", () => {
      expect(thrown(tallyWith(`      | loud | yes |\n`), tallyScope)).toMatch(
        /^x\.feature:3: loud in tally's input cannot be "yes": /,
      );
      expect(thrown(tallyWith(`      | count | many |\n`), tallyScope)).toMatch(
        /^x\.feature:3: count in tally's input cannot be "many": /,
      );
    });

    it("refuses a field the input does not have, in a table and in a doc string, naming those it has", () => {
      expect(thrown(tallyWith(`      | titel | Launch |\n`), tallyScope)).toBe(
        'x.feature:3: no field "titel" in tally\'s input; it has title, count, loud, tags',
      );
      expect(
        thrown(`Feature: A
  Scenario: S
    When announce runs
    Then ghost.post.create was called with
      """
      { "titel": "Launch" }
      """
`),
      ).toBe('x.feature:4: no field "titel" in ghost.post.create\'s input; it has title, html, status');
    });

    it("checks each field of a doc string against its schema", () => {
      expect(
        thrown(`Feature: A
  Scenario: S
    Given ghost.post.create was called with
      """
      { "title": 7 }
      """
    When announce runs
`),
      ).toMatch(/^x\.feature:3: title in ghost\.post\.create's input cannot be 7: /);
    });

    it("reads a phrase's field as its own type, even one named like a built-in type", () => {
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
      const drivers = [...marketingFakes().drivers, { vendor: "runs", ops: { "run.start": async () => ({}) } }];
      const [scenario] = parseFeature(
        `Feature: A\n  Scenario: S\n    Given a run of "refund all" with 3 tries exists\n    When announce runs\n`,
        "x.feature",
        scopeOf([ghost, resend, bluesky, runs], drivers),
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

  it("refuses a phrase naming a field its operation's input does not have", () => {
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
    const drivers = [...marketingFakes().drivers, { vendor: "odd", ops: { "thing.poke": async () => ({}) } }];
    expect(() => parseFeature("Feature: A\n", "x.feature", scopeOf([ghost, resend, bluesky, odd], drivers))).toThrow(
      'odd.thing.poke: its given phrase "{nope} poked" names {nope}, which is not a field of its input',
    );
  });

  it("refuses a scenario with no When, a second When, and a doc string that is not JSON", () => {
    expect(thrown(`Feature: A\n  Scenario: Idle\n    Then the run succeeds\n`)).toMatch(
      /^x\.feature:2: scenario "Idle" has no When/,
    );
    expect(thrown(`Feature: A\n  Scenario: Twice\n    When announce runs\n    And announce runs\n`)).toBe(
      "x.feature:4: a second When: a scenario runs its workflow once",
    );
    expect(
      thrown(`Feature: A\n  Scenario: Bad\n    When announce runs with\n      """\n      { title: 1 }\n      """\n`),
    ).toMatch(/^x\.feature:3: the doc string after "announce runs with" is not JSON: /);
  });
});

describe("loadScenarios", () => {
  const dir = mkdtempSync(join(tmpdir(), "sanoma-scenarios-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("loads every feature file, and refuses a name used twice across files", () => {
    writeFileSync(join(dir, "a.feature"), feature("Same"));
    writeFileSync(join(dir, "b.feature"), `${feature("Same")}\n  Scenario: Other\n    When announce runs\n`);
    writeFileSync(join(dir, "c.feature"), "Feature: A\n  Scenario: Broken\n    Then nothing\n");
    const { scenarios, errors } = loadScenarios({ ...scope, scenarios: pathToFileURL(`${dir}/`) });
    expect(scenarios.map((s) => [s.file, s.name])).toEqual([
      ["a.feature", "Same"],
      ["b.feature", "Other"],
    ]);
    expect(errors).toEqual([
      { file: "b.feature", message: 'b.feature: scenario "Same" is also in a.feature; give each its own name' },
      { file: "c.feature", message: expect.stringMatching(/^c\.feature:3: no step matches "nothing"/) },
    ]);
  });

  it("parses the files again only once one has changed", () => {
    const sub = join(dir, "cached");
    mkdirSync(sub);
    writeFileSync(join(sub, "a.feature"), feature("First"));
    const cachedScope = { ...scope, scenarios: pathToFileURL(`${sub}/`) };
    const first = loadScenarios(cachedScope);
    expect(loadScenarios(cachedScope)).toBe(first);

    // Written again, longer, so the stamp changes even where the clock is coarse.
    writeFileSync(join(sub, "a.feature"), feature("First, renamed"));
    const second = loadScenarios(cachedScope);
    expect(second).not.toBe(first);
    expect(second.scenarios.map((s) => s.name)).toEqual(["First, renamed"]);

    writeFileSync(join(sub, "b.feature"), feature("Second"));
    expect(loadScenarios(cachedScope).scenarios.map((s) => s.name)).toEqual(["First, renamed", "Second"]);
  });

  it("finds no scenarios, and no errors, without a directory", () => {
    expect(loadScenarios({ ...scope, scenarios: pathToFileURL(join(dir, "missing/")) })).toEqual({
      scenarios: [],
      errors: [],
    });
    expect(loadScenarios(scope)).toEqual({ scenarios: [], errors: [] });
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

  it("matches an operation's input as a subset, at every depth", () => {
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

  it("passes `was not called` only when there is no call", () => {
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

  it("counts a call that failed (denied, rejected, or failed at the vendor) as attempted, not made", () => {
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

  it("reads the outcome from the run's last record: finished, failed with a code, or not ended", () => {
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
