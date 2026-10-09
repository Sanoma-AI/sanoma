import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { allowAll, defineConnector, type LedgerRecord, memoryLedger, resolveConfig } from "../src/index.ts";
import { check, loadScenarios, parseFeature, Scenario, type Scope } from "../src/scenario.ts";
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
  it("reads the generic steps and the connectors' phrases into a scenario", () => {
    const [scenario, ...rest] = parse(LAUNCH);
    expect(rest).toEqual([]);
    expect(scenario).toMatchObject({
      name: "Launch on time",
      file: "announce.feature",
      workflow: "announce",
      text: LAUNCH,
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
    // Plain JSON, as its schema describes it.
    expect(Scenario.parse(JSON.parse(JSON.stringify(scenario)))).toEqual(scenario);
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

  it("reads a workflow's input from a two-column table, parsing values that are JSON", () => {
    const [scenario] = parse(`Feature: Announce
  Scenario: Table
    When announce runs with
      | title    | Table launch         |
      | launchAt | 2030-01-01T09:00:00Z |
      | audience | "vip"                |
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

  it("names the file and line of a step nothing matches, and lists the steps it knows, phrases under their operation", () => {
    const message = thrown(`Feature: Announce
  Scenario: Moon
    When announce runs
    Then the moon is out
`);
    expect(message).toMatch(/^x\.feature:4: no step matches "the moon is out"\nKnown steps:\n/);
    expect(message).toContain("  Given {op} was called with (and a JSON doc string)\n");
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
      { step: "create", ok: false, detail: "ghost.post.create was called" },
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
