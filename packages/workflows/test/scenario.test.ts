import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bluesky } from "@sanoma-ai/connector-bluesky";
import { ghost } from "@sanoma-ai/connector-ghost";
import { resend } from "@sanoma-ai/connector-resend";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineFake, type Fake } from "../src/fake.ts";
import {
  defineConnector,
  defineResource,
  defineSteps,
  defineWorkflow,
  type LedgerRecord,
  memoryLedger,
  resolveConfig,
} from "../src/index.ts";
import { missingResourceFake, seedResource } from "../src/sandbox.ts";
import { type CoreExpectation, detailOf } from "../src/expectations.ts";
import { check as checkRun, loadScenarios, type Scenario, type Scope } from "../src/scenario.ts";
import announce from "./fixtures/announce.ts";
import { companyConfig } from "./fixtures/company/fakes.ts";
import inspect from "./fixtures/company/workflows/inspect.ts";
import peopleConfig from "./fixtures/people/sanoma.config.ts";
import { withFake } from "@sanoma-ai/testing";

// The packages' connectors carry their drivers: announce's operations have one.
const scopeOf = (connectors: Parameters<typeof resolveConfig>[0]["connectors"]) => {
  const resolved = resolveConfig({
    workflows: [announce],
    connectors,
    ledger: memoryLedger(),
  });
  return resolved satisfies Scope;
};
const scope = scopeOf([ghost, resend, bluesky]);

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A directory of its own with these files, and the scope that reads its scenarios. */
function scenariosDir(files: Record<string, string>, s: Scope = scope) {
  const dir = mkdtempSync(join(tmpdir(), "sanoma-feature-"));
  dirs.push(dir);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return { dir, scope: { ...s, scenarios: pathToFileURL(`${dir}/`) } };
}

/** Compiles the text as `file` in a directory of its own: that directory's scope, its scenarios and errors. */
async function compiled(text: string, s: Scope = scope, file = "scenarios/x.feature") {
  const within = scenariosDir({ [file]: text }, s).scope;
  return { scope: within, ...(await loadScenarios(within)) };
}

/** The scenarios of one feature file with this text; throws the file's error. */
async function parseFeature(text: string, file: string, s: Scope): Promise<Scenario[]> {
  const { scenarios, errors } = await compiled(text, s, file);
  if (errors.length) throw new Error(errors.map((e) => e.message).join("\n"));
  return scenarios;
}
const parse = (text: string, file = "scenarios/announce.feature") => parseFeature(text, file, scope);
/** What compiling throws, as its message. */
const thrown = async (text: string, s: Scope = scope) => {
  try {
    await parseFeature(text, "scenarios/x.feature", s);
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

/** A scenario that expects crm.contact.save with `given` (a doc string's or a table's lines), after `keyword`. */
const saving = (given: string, keyword = "Then") =>
  `Feature: A\n  Scenario: S\n    When announce runs\n    ${keyword} crm.contact.save was called with\n${given}`;
const doc = (json: string) => `      """\n      ${json}\n      """\n`;

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
      file: "scenarios/announce.feature",
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
    expect(await thrown("Feature: Empty\n")).toBe('scenarios/x.feature: no scenarios; add one with "Scenario: <name>"');
  });

  it("names the file and line of a step nothing matches, and lists the steps it knows, phrases under their operation", async () => {
    const message = await thrown(`Feature: Announce
  Scenario: Moon
    When announce runs
    Then the moon is out
`);
    expect(message).toMatch(/^scenarios\/x\.feature:4: no step matches "the moon is out"\nKnown steps:\n/);
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
      /^scenarios\/x\.feature:3: no operation "ghost\.post\.burn"; the config has bluesky\.post\.create, ghost\.post\.create, /,
    );
    expect(await thrown(`Feature: A\n  Scenario: S\n    When refund runs\n`)).toBe(
      'scenarios/x.feature:3: no workflow "refund"; the config has announce, call, change',
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
      'scenarios/x.feature:3: "ghost.post.publish fails once" is ambiguous: it matches "{op} fails once" and "{id} fails once"',
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
        "scenarios/x.feature",
        tallyScope,
      );
      expect(scenario?.input).toEqual({ title: "123", count: 5, loud: true, tags: ["a", "b"] });
    });

    it("refuses a value its field does not take, naming the field", async () => {
      expect(await thrown(tallyWith(`      | loud | yes |\n`), tallyScope)).toMatch(
        /^scenarios\/x\.feature:3: loud in tally's input cannot be "yes": /,
      );
      expect(await thrown(tallyWith(`      | count | many |\n`), tallyScope)).toMatch(
        /^scenarios\/x\.feature:3: count in tally's input cannot be "many": /,
      );
    });

    it("refuses a field the input does not have, in a table and in a doc string, naming those it has", async () => {
      expect(await thrown(tallyWith(`      | titel | Launch |\n`), tallyScope)).toBe(
        'scenarios/x.feature:3: no field "titel" in tally\'s input; it has title, count, loud, tags',
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
      ).toBe('scenarios/x.feature:4: no field "titel" in ghost.post.create\'s input; it has title, html, status');
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
      ).toMatch(/^scenarios\/x\.feature:3: title in ghost\.post\.create's input cannot be 7: /);
    });

    describe("an expected call's object fields", () => {
      const crm = defineConnector("crm", {
        contact: {
          save: {
            effect: "write",
            input: z.object({
              record: z.object({
                name: z.string(),
                stage: z.enum(["lead", "won"]),
                owner: z.object({ id: z.string() }),
                meta: z.looseObject({ source: z.string() }),
              }),
            }),
            output: z.object({}),
            phrases: { expect: "a contact {record} is saved" },
          },
        },
      });
      const crmScope = scopeOf([ghost, resend, bluesky, crm]);
      it("takes some fields of an object at any depth, from a doc string or a table cell", async () => {
        for (const given of [
          doc('{ "record": { "stage": "won", "owner": {} } }'),
          '      | record | { "stage": "won", "owner": {} } |\n',
        ]) {
          const [scenario] = await parseFeature(saving(given), "scenarios/x.feature", crmScope);
          expect(scenario?.expect).toEqual([
            expect.objectContaining({ op: "crm.contact.save", input: { record: { stage: "won", owner: {} } } }),
          ]);
        }
      });

      it("takes some fields of an object in an expect phrase too", async () => {
        const [scenario] = await parseFeature(
          `Feature: A\n  Scenario: S\n    When announce runs\n    Then a contact '{ "stage": "won" }' is saved\n`,
          "scenarios/x.feature",
          crmScope,
        );
        expect(scenario?.expect).toEqual([
          expect.objectContaining({ op: "crm.contact.save", input: { record: { stage: "won" } } }),
        ]);
      });

      it("takes a field a loose object does not name", async () => {
        const given = doc('{ "record": { "meta": { "campaign": "fall" } } }');
        const [scenario] = await parseFeature(saving(given), "scenarios/x.feature", crmScope);
        expect(scenario?.expect).toEqual([
          expect.objectContaining({ input: { record: { meta: { campaign: "fall" } } } }),
        ]);
      });

      it("checks the fields given against their schemas, naming the nested field", async () => {
        expect(await thrown(saving(doc('{ "record": { "stage": "lost" } }')), crmScope)).toMatch(
          /^scenarios\/x\.feature:4: stage in record in crm\.contact\.save's input cannot be "lost": /,
        );
        expect(await thrown(saving(doc('{ "record": { "owner": { "name": "Ada" } } }')), crmScope)).toBe(
          'scenarios/x.feature:4: no field "name" in owner in record in crm.contact.save\'s input; it has id',
        );
      });

      it("still needs a whole object to seed a call", async () => {
        expect(await thrown(saving(doc('{ "record": { "stage": "won" } }'), "Given"), crmScope)).toMatch(
          /^scenarios\/x\.feature:4: record in crm\.contact\.save's input cannot be \{"stage":"won"\}: /,
        );
      });
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
        "scenarios/x.feature",
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
    await expect(
      parseFeature("Feature: A\n", "scenarios/x.feature", scopeOf([ghost, resend, bluesky, odd])),
    ).rejects.toThrow(
      'odd.thing.poke: its given phrase "{nope} poked" names {nope}, which is not a field of its input',
    );
  });

  it("refuses a scenario with no When, a second When, and a doc string that is not JSON", async () => {
    expect(await thrown(`Feature: A\n  Scenario: Idle\n    Then the run succeeds\n`)).toMatch(
      /^scenarios\/x\.feature:2: scenario "Idle" has no When/,
    );
    expect(await thrown(`Feature: A\n  Scenario: Twice\n    When announce runs\n    And announce runs\n`)).toBe(
      "scenarios/x.feature:4: a second When: a scenario runs its workflow once",
    );
    expect(
      await thrown(
        `Feature: A\n  Scenario: Bad\n    When announce runs with\n      """\n      { title: 1 }\n      """\n`,
      ),
    ).toMatch(/^scenarios\/x\.feature:3: the doc string after "announce runs with" is not JSON: /);
  });
});

describe("loadScenarios", () => {
  const dir = mkdtempSync(join(tmpdir(), "sanoma-scenarios-"));
  mkdirSync(join(dir, "scenarios"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("loads every feature file, and refuses a name used twice across files", async () => {
    writeFileSync(join(dir, "scenarios/a.feature"), feature("Same"));
    writeFileSync(join(dir, "scenarios/b.feature"), `${feature("Same")}\n  Scenario: Other\n    When announce runs\n`);
    writeFileSync(join(dir, "scenarios/c.feature"), "Feature: A\n  Scenario: Broken\n    Then nothing\n");
    const { scenarios, errors } = await loadScenarios({ ...scope, scenarios: pathToFileURL(`${dir}/`) });
    expect(scenarios.map((s) => [s.file, s.name])).toEqual([
      ["scenarios/a.feature", "Same"],
      ["scenarios/b.feature", "Other"],
    ]);
    expect(errors).toEqual([
      {
        file: "scenarios/b.feature",
        message: 'scenarios/b.feature: scenario "Same" is also in scenarios/a.feature; give each its own name',
      },
      {
        file: "scenarios/c.feature",
        message: expect.stringMatching(/^scenarios\/c\.feature:3: no step matches "nothing"/),
      },
    ]);
  });

  it("compiles the files again only once one has changed", async () => {
    const sub = join(dir, "cached");
    mkdirSync(join(sub, "scenarios"), { recursive: true });
    writeFileSync(join(sub, "scenarios/a.feature"), feature("First"));
    const cachedScope = { ...scope, scenarios: pathToFileURL(`${sub}/`) };
    const first = await loadScenarios(cachedScope);
    expect(await loadScenarios(cachedScope)).toBe(first);

    // Written again, longer, so the stamp changes even where the clock is coarse.
    writeFileSync(join(sub, "scenarios/a.feature"), feature("First, renamed"));
    const second = await loadScenarios(cachedScope);
    expect(second).not.toBe(first);
    expect(second.scenarios.map((s) => s.name)).toEqual(["First, renamed"]);

    writeFileSync(join(sub, "scenarios/b.feature"), feature("Second"));
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
  const company = resolveConfig({ ...companyConfig([inspect]), ledger: memoryLedger() });
  const parseCompany = (text: string) => parseFeature(text, "scenarios/company.feature", company);
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
    And resources/billing/stripe.ts#events is absent
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
        { declared: "resources/billing/stripe.ts#events", status: "absent" },
      ],
    });
    // A step about a resource names no operation.
    expect(drift!.steps.map((s) => s.op)).toEqual(Array(7).fill(undefined));

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
      ledger: memoryLedger(),
    });
    const [seeded] = await parseFeature(
      `Feature: Ping\n  Scenario: Seeded\n    Given acme.hook "deploys" has\n      | url | https://example.com |\n    And acme.hook "other" is gone\n    When ping runs\n`,
      "scenarios/ping.feature",
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
      'scenarios/x.feature:3: no resource type "github.gist"; the config has github.branch_protection, github.repository, github.repository_deploy_key, github.team_membership, stripe.product, stripe.webhook_endpoint',
    );
    expect(await thrown(drifting('    Given github.repository "x" has\n      | nope | 1 |\n'), company)).toMatch(
      /^scenarios\/x\.feature:3: no field "nope" in github\.repository "x"; it has allow_auto_merge, /,
    );
    expect(await thrown(drifting('    Given github.repository "x" has\n      | has_wiki | yes |\n'), company)).toMatch(
      /^scenarios\/x\.feature:3: has_wiki in github\.repository "x" cannot be "yes": /,
    );
    expect(
      await thrown(
        `Feature: A\n  Scenario: S\n    When inspect runs\n    Then resources/identity/github.ts#website is clean\n`,
        company,
      ),
    ).toBe(
      'scenarios/x.feature:2: "resources/identity/github.ts#website is clean" reads a drift report, so the scenario must run drift, not inspect',
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
        { step: "absent", declared: "resources/identity/github.ts#docs", status: "absent" },
        { step: "clean", declared: "resources/identity/rules.ts#docsMain", status: "clean" },
        { step: "unread", declared: "resources/billing/stripe.ts#pro", status: "clean" },
        { step: "unknown", declared: "resources/x.ts#y", status: "clean" },
      ];
      expect(details(results, ended(finished(report)))).toEqual([
        undefined,
        `${website} is drifted in has_wiki, topics, not drifted in name`,
        `${website} is drifted in has_wiki, topics, not clean`,
        "resources/identity/github.ts#docs is clean, not gone",
        "resources/identity/github.ts#docs is clean, not absent",
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

/** A feature with one scenario that runs named, then these steps. */
const runNamed = (steps: string) => `Feature: N\n  Scenario: S\n    When named runs\n${steps}`;

describe("steps by name", () => {
  /** Drafts a post per title under one name, publishes two by the default name, and waits under a name. */
  const named = defineWorkflow({
    name: "named",
    title: "Post by name",
    trigger: "manual",
    input: z.object({ titles: z.array(z.string()) }),
    uses: [ghost.post.create, ghost.post.publish, "approval", "sleep"],
    run: async (ctx, { titles }) => {
      for (const title of titles) {
        await ctx.ghost.post.create({ title, html: title, status: "draft" }, { name: "Draft the post" });
      }
      await ctx.approval("Go ahead", { approver: "marketing-lead" });
      await ctx.ghost.post.publish({ id: "a" });
      await ctx.ghost.post.publish({ id: "b" });
      await ctx.sleep({ seconds: 1 }, { name: "Let it settle" });
      return {};
    },
  });
  /** Publishes by a computed segment, which a run names by the operation it calls, by the default name, and by a name. */
  const computed = defineWorkflow({
    name: "computed",
    title: "Publish two ways",
    trigger: "manual",
    input: z.object({ action: z.enum(["publish"]) }),
    uses: [ghost.post.publish],
    run: async (ctx, { action }) => {
      await ctx.ghost.post[action]({ id: "a" });
      await ctx.ghost.post.publish({ id: "b" });
      await ctx.ghost.post.publish({ id: "c" }, { name: "Publish c" });
      return {};
    },
  });
  const within = resolveConfig({
    workflows: [named, computed],
    connectors: [ghost],
    ledger: memoryLedger(),
  });
  const failing = async (text: string) => (await compiled(text, within)).errors.map((e) => e.message).join("\n");

  const common = { v: 1, app: "a", runId: "r", at: 0, actor: { id: "alice" }, workflow: "named" } as const;
  const draft = (seq: number, title: string, error?: { code: string; name: string; message: string }) =>
    ({
      ...common,
      id: `r:op.called:${seq}`,
      seq,
      type: "op.called",
      op: "ghost.post.create",
      name: "Draft the post",
      effect: "write",
      input: { title, html: title, status: "draft" },
      decision: { kind: "allow" },
      durationMs: 1,
      ...(error ? { error } : {}),
    }) as LedgerRecord;
  /** A policy's hold on a draft: it carries the held call's name, and is not a run of its own. */
  const hold: LedgerRecord = {
    ...common,
    id: "r:approval.requested:4",
    seq: 4,
    type: "approval.requested",
    approval: "ap1",
    name: "Draft the post",
    title: "Draft?",
    approver: "marketing-lead",
    requestedBy: "policy",
    covers: ["ghost.post.create"],
    op: "ghost.post.create",
  };
  const records = [
    draft(1, "One"),
    draft(2, "Two"),
    draft(3, "Three", { code: "driver_failed", name: "DriverError", message: "down" }),
    hold,
    {
      ...common,
      id: "r:approval.requested:5",
      seq: 5,
      type: "approval.requested",
      approval: "ap2",
      name: "Go ahead",
      title: "Go ahead",
      approver: "marketing-lead",
      requestedBy: "workflow",
      covers: [],
    },
  ] as LedgerRecord[];

  it("reads a step's name into an expectation, with its operation when it calls one", async () => {
    const { scenarios, errors } = await compiled(
      runNamed(
        '    Then step "Draft the post" was called with\n      | title | One |\n    And step "Draft the post" ran 2 times\n    And step "Let it settle" was not called\n    And step "Go ahead" ran 1 time\n',
      ),
      within,
    );
    expect(errors).toEqual([]);
    expect(scenarios[0]!.expect).toEqual([
      {
        step: 'step "Draft the post" was called with',
        name: "Draft the post",
        input: { title: "One" },
        called: true,
      },
      { step: 'step "Draft the post" ran 2 times', name: "Draft the post", times: 2 },
      { step: 'step "Let it settle" was not called', name: "Let it settle", called: false },
      { step: 'step "Go ahead" ran 1 time', name: "Go ahead", times: 1 },
    ]);
    // For marking the graph: the step it is about by name, and whether it expects a run.
    expect(scenarios[0]!.steps.filter((s) => s.kind === "then").map(({ name, called }) => ({ name, called }))).toEqual([
      { name: "Draft the post", called: true },
      { name: "Draft the post", called: true },
      { name: "Let it settle", called: false },
      { name: "Go ahead", called: true },
    ]);
    const zero = await compiled(runNamed('    Then step "Go ahead" ran 0 times\n'), within);
    expect(zero.scenarios[0]!.steps.at(-1)).toMatchObject({ name: "Go ahead", called: false });
  });

  it("refuses a name no step has, one several steps share, input for a sleep, and a step name before the When", async () => {
    expect(await failing(runNamed('    Then step "Publish" was called\n'))).toMatch(
      /no step of named is named "Publish"; its steps are "Draft the post", "Go ahead", "ghost\.post\.publish", "Let it settle"/,
    );
    expect(await failing(runNamed('    Then step "ghost.post.publish" was called\n'))).toMatch(
      /2 steps of named are named "ghost\.post\.publish": give the one to check a name of its own/,
    );
    expect(await failing(runNamed('    Then step "Let it settle" was called with\n      | id | a |\n'))).toMatch(
      /step "Let it settle" is a sleep, which takes no input/,
    );
    expect(
      await failing('Feature: N\n  Scenario: S\n    Then step "Go ahead" was called\n    When named runs\n'),
    ).toMatch(/step "Go ahead" names a step of a workflow: it goes after the When that runs one, in scenarios\//);
    // An unnamed call with a computed segment may be the operation's own default name.
    const publish =
      'Feature: C\n  Scenario: S\n    When computed runs\n    Then step "ghost.post.publish" was called\n';
    expect(await failing(publish)).toMatch(/2 steps of computed are named "ghost\.post\.publish"/);
    expect(
      await failing('Feature: C\n  Scenario: S\n    When computed runs\n    Then step "Publish c" ran 1 time\n'),
    ).toBe("");
  });

  it("counts the runs a step's records carry its name for: calls made, not failed ones or a policy's hold", () => {
    expect(
      check(
        {
          ...expecting([
            { step: "two", name: "Draft the post", times: 2 },
            { step: "three", name: "Draft the post", times: 3 },
            { step: "with", name: "Draft the post", input: { title: "Two" }, called: true },
            { step: "failed", name: "Draft the post", input: { title: "Three" }, called: true },
            { step: "settle", name: "Let it settle", called: false },
            { step: "drafted", name: "Draft the post", called: false },
            { step: "asked", name: "Go ahead", times: 1 },
          ]),
          workflow: "named",
        },
        records,
      ),
    ).toEqual([
      { step: "two", ok: true },
      { step: "three", ok: false, detail: 'step "Draft the post" ran twice, not 3 times' },
      { step: "with", ok: true },
      {
        step: "failed",
        ok: false,
        detail: expect.stringMatching(
          /^step "Draft the post" was not called with \{"title":"Three"\}; its calls had .*; attempted: driver_failed: down$/,
        ),
      },
      { step: "settle", ok: true },
      { step: "drafted", ok: false, detail: expect.stringMatching(/^step "Draft the post" was called with /) },
      { step: "asked", ok: true },
    ]);
  });

  it("checks a run's named steps through Cucumber", async () => {
    const { scope: s, scenarios } = await compiled(
      runNamed(
        '    Then step "Draft the post" ran 2 times\n    And step "Go ahead" was called\n    And step "Let it settle" was called\n',
      ),
      within,
    );
    expect(await checkRun(s, scenarios[0]!, records)).toEqual([
      { step: 'step "Draft the post" ran 2 times', ok: true },
      { step: 'step "Go ahead" was called', ok: true },
      { step: 'step "Let it settle" was called', ok: false, detail: 'step "Let it settle" was not called' },
    ]);
  });
});

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

  it("names the file and line where Gherkin cannot parse a file, and leaves it out, the others compiling", async () => {
    expect(await thrown(`Feature: A\n  Scenario: S\n    When announce runs\n  Feature: B\n`)).toMatch(
      /^scenarios\/x\.feature:4: \(4:3\): expected: /,
    );
    const both = await loadScenarios(
      scenariosDir({
        "scenarios/a.feature": "Feature: A\n  Scenario: S\n    When announce runs\n  Feature: B\n",
        "scenarios/b.feature": feature("Fine"),
      }).scope,
    );
    expect(both.scenarios.map((s) => s.name)).toEqual(["Fine"]);
    expect(both.errors.map((e) => e.file)).toEqual(["scenarios/a.feature"]);
  });

  it("reads and checks files whose paths a glob or Cucumber would read otherwise: @, brackets, braces", async () => {
    const files = {
      "scenarios/@smoke.feature": feature("Smoke"),
      "scenarios/x[1].feature": feature("Bracketed"),
      "scenarios/d[1]{a,b}/in (2).feature": feature("Nested"),
    };
    const { scope: within } = scenariosDir(files);
    const { scenarios, errors } = await loadScenarios(within);
    expect(errors).toEqual([]);
    expect(scenarios.map((s) => [s.file, s.name])).toEqual([
      ["scenarios/@smoke.feature", "Smoke"],
      ["scenarios/d[1]{a,b}/in (2).feature", "Nested"],
      ["scenarios/x[1].feature", "Bracketed"],
    ]);
    for (const s of scenarios) expect(await checkRun(within, s, [])).toEqual([]);
  });

  it("reads the connectors' steps: a seed named for an operation's own test, and a Then of the connector's own", async () => {
    const text = readFileSync(new URL("./fixtures/scenarios/compose.feature", import.meta.url), "utf8");
    const [scenario] = await parse(text, "scenarios/compose.feature");
    expect(scenario?.given).toMatchObject([
      { step: 'a Ghost draft titled "Old news"', op: "ghost.post.create", input: { title: "Old news" }, as: "draft" },
      { step: "Resend fails to send once", op: "resend.broadcast.send", fault: "failNext" },
    ]);
    expect(scenario?.expect).toEqual([
      { step: 'the Ghost post "Acme Pro" is published', custom: true, op: "ghost.post.publish", called: true },
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
      "scenarios/x.feature:3: \"ghost.post.publish is called with\" calls ghost.post.publish directly: a step for an operation's own test, in its connector's features",
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

    it("runs the Then steps against the ledger, each judged on its own: one check per expectation, in order", async () => {
      const { scope: within, scenarios } = await compiled(LAUNCH);
      const [launch] = scenarios as [Scenario];
      const checks = await checkRun(within, launch, records);
      expect(checks.map((c) => c.step)).toEqual(launch.expect.map((e) => e.step));
      expect(checks.slice(0, 2)).toEqual([
        { step: 'a post titled "Acme Pro" is created', ok: true },
        { step: "ghost.post.publish was called", ok: false, detail: "no call to ghost.post.publish" },
      ]);
      // A step after one that does not hold is still checked.
      expect(checks.at(-1)).toEqual({ step: "the run succeeds", ok: true });
    });

    it("checks a connector's own Then step, and one whose code throws", async () => {
      const throwing = defineSteps("odd", ({ then }) => {
        then("the odd check throws", () => ({
          check: () => {
            throw new Error("it threw");
          },
        }));
      });
      const text = `Feature: A\n  Scenario: S\n    When announce runs\n    Then the odd check throws\n    And the Ghost post "Acme Pro" is published\n    And the run succeeds\n`;
      const { scope: within, scenarios } = await compiled(text, { ...scope, steps: [...scope.steps, throwing] });
      expect(await checkRun(within, scenarios[0]!, records)).toEqual([
        { step: "the odd check throws", ok: false, detail: "it threw" },
        {
          step: 'the Ghost post "Acme Pro" is published',
          ok: false,
          detail: expect.stringMatching(/was not published$/),
        },
        { step: "the run succeeds", ok: true },
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
      writeFileSync(
        join(fileURLToPath(within.scenarios), "scenarios/x.feature"),
        text.replace("    And the run succeeds\n", ""),
      );
      await expect(checkRun(within, s, records)).rejects.toThrow(
        'scenarios/x.feature:2: scenario "S" no longer has the expectations it was read with',
      );
    });
  });
});

/** A feature with one scenario of these steps. */
const scenarioOf = (steps: string) => `Feature: R\n  Scenario: S\n${steps}`;

describe("people in a scenario: who is acting, held for a group, denied with a reason", () => {
  // The people fixture's root declares ada, bo, the agent refund-bot and the group finance.
  const people = resolveConfig(peopleConfig);
  const parsePeople = (text: string) => parseFeature(text, "scenarios/people.feature", people);

  it("reads who starts the run, a hold for a group and a denial's reason", async () => {
    const text = readFileSync(new URL("./fixtures/people/scenarios/refund.feature", import.meta.url), "utf8");
    const [held, denied] = await parsePeople(text);
    expect(held).toMatchObject({
      startedBy: "bo",
      expect: [
        { op: "shop.refunds.create", decision: "held", approver: { group: "finance" } },
        { op: "shop.refunds.create", called: true },
        { outcome: "finished" },
      ],
    });
    expect(held!.steps[0]).toEqual({ text: "bo is acting", kind: "given" });
    expect(held!.given).toEqual([]);
    expect(denied).toMatchObject({
      startedBy: "refund-bot",
      expect: [
        { op: "shop.refunds.create", decision: "denied", reason: "Agents do not refund" },
        { outcome: "failed" },
      ],
    });
    expect(denied!.steps[2]).toMatchObject({ op: "shop.refunds.create", decision: "denied" });
  });

  it("reads a visitor, and anonymous, as who starts the run", async () => {
    const text = readFileSync(new URL("./fixtures/people/scenarios/refund.feature", import.meta.url), "utf8");
    const [, , visitor, anonymous] = await parsePeople(text);
    expect(visitor).toMatchObject({ startedBy: "visitor:scenario:visitor" });
    expect(visitor!.steps[0]).toEqual({ text: "a visitor is acting", kind: "given" });
    expect(anonymous).toMatchObject({ startedBy: "anonymous" });
  });

  it("refuses someone, or a group, the data files do not declare, and a second actor", async () => {
    const thrownBy = async (steps: string) => {
      try {
        await parsePeople(scenarioOf(steps));
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error("expected the feature not to load");
    };
    expect(await thrownBy("    Given cy is acting\n    When refund runs\n")).toBe(
      "scenarios/people.feature:3: cy is not a declared person or agent; resources/ declares ada, bo, refund-bot, scenarios, host-check, schedule, wakeup",
    );
    expect(await thrownBy('    When refund runs\n    Then shop.refunds.create was held for group "sales"\n')).toBe(
      'scenarios/people.feature:4: no group "sales"; resources/ declares agents, finance, visitors',
    );
    expect(await thrownBy("    Given ada is acting\n    And bo is acting\n    When refund runs\n")).toBe(
      "scenarios/people.feature:4: ada is acting already: a run has one actor",
    );
    // A runtime agent is always declared, and a group by a person's id is not a group.
    await expect(
      parsePeople(scenarioOf("    Given scenarios is acting\n    When refund runs\n")),
    ).resolves.toMatchObject([{ startedBy: "scenarios" }]);
    expect(await thrownBy('    When refund runs\n    Then shop.refunds.create was held for group "ada"\n')).toMatch(
      /no group "ada"/,
    );
  });

  it("lets no one but the runtime's agents act while the people's files have problems", async () => {
    const root = mkdtempSync(join(tmpdir(), "sanoma-people-"));
    dirs.push(root);
    mkdirSync(join(root, "resources"));
    writeFileSync(
      join(root, "resources", "people.ts"),
      `import { sanoma } from "@sanoma-ai/workflows/resources";\n\nexport const ada = sanoma.person({ id: "ada" });\nexport const other = sanoma.person({ id: "ada" });\n`,
    );
    const broken = { ...people, root };
    await expect(
      parseFeature(scenarioOf("    Given ada is acting\n    When refund runs\n"), "scenarios/x.feature", broken),
    ).rejects.toThrow(
      /^scenarios\/x\.feature:3: ada cannot be admitted while the people's files have problems: resources\/people\.ts:4:1: sanoma\.person "ada" is declared twice/,
    );
    await expect(
      parseFeature(scenarioOf("    Given scenarios is acting\n    When refund runs\n"), "scenarios/x.feature", broken),
    ).resolves.toMatchObject([{ startedBy: "scenarios" }]);
    await expect(
      parseFeature(
        scenarioOf('    When refund runs\n    Then shop.refunds.create was held for group "finance"\n'),
        "scenarios/x.feature",
        broken,
      ),
    ).rejects.toThrow(/^scenarios\/x\.feature:4: no group can be told while the people's files have problems: /);
  });

  it("takes any id, and any group, while the data files declare no one", async () => {
    const [s] = await parse(
      'Feature: A\n  Scenario: S\n    Given whoever is acting\n    When announce runs\n    Then ghost.post.publish was held for group "editors"\n',
    );
    expect(s).toMatchObject({
      startedBy: "whoever",
      expect: [{ op: "ghost.post.publish", decision: "held", approver: { group: "editors" } }],
    });
  });

  it("says who a hold was for when it was not the group, and what a denial said when it was not the reason", () => {
    const common = { v: 1, app: "a", runId: "r", at: 0, actor: { id: "bo" }, workflow: "refund" } as const;
    const op = "shop.refunds.create";
    const called = (seq: number, decision: Extract<LedgerRecord, { type: "op.called" }>["decision"]) =>
      ({
        ...common,
        id: `r:op.called:${seq}`,
        seq,
        type: "op.called",
        op,
        effect: "money",
        input: { amount: 1 },
        decision,
        durationMs: 1,
      }) as LedgerRecord;
    const heldFor = (approver: Extract<LedgerRecord, { type: "approval.requested" }>["approver"]) =>
      ({
        ...common,
        id: "r:approval.requested:1",
        seq: 1,
        type: "approval.requested",
        approval: "approval-1",
        title: "Refund over 10,000",
        approver,
        requestedBy: "policy",
        op,
        covers: [op],
      }) as LedgerRecord;
    const denied = [called(0, { kind: "deny", reason: "Agents do not refund" })];
    expect(detailOf({ op, decision: "denied", reason: "Agents do not refund" }, denied)).toBeUndefined();
    expect(detailOf({ op, decision: "denied" }, denied)).toBeUndefined();
    expect(detailOf({ op, decision: "denied", reason: "No" }, denied)).toBe(
      'shop.refunds.create was denied with "Agents do not refund", not "No"',
    );
    expect(detailOf({ op, decision: "denied", reason: "No" }, [called(0, { kind: "allow" })])).toBe(
      "shop.refunds.create was allowed, not denied",
    );
    const group = { op, decision: "held", approver: { group: "finance" } } as const;
    expect(detailOf(group, [heldFor({ group: "finance" })])).toBeUndefined();
    // A person named like the group is not the group; `held for {who}` takes either.
    expect(detailOf(group, [heldFor("finance")])).toBe("shop.refunds.create was held for finance, not group finance");
    expect(detailOf({ op, decision: "held", approver: "finance" }, [heldFor("finance")])).toBeUndefined();
  });
});
