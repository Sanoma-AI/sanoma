import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  type Argument,
  CucumberExpression,
  ParameterType,
  ParameterTypeRegistry,
} from "@cucumber/cucumber-expressions";
import { AstBuilder, compile, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin";
import { type GherkinDocument, IdGenerator, type PickleStep, PickleStepType } from "@cucumber/messages";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { faker } from "@faker-js/faker";
import { fake, seed, setFaker } from "zod-schema-faker/v4";
import { z } from "zod";
import type { RunSummary, SanomaClient } from "./client.ts";
import type { WorkflowDefinition } from "./define.ts";
import { SanomaError } from "./errors.ts";
import { entry, type LedgerRecord, write } from "./ledger.ts";
import type { Op } from "./op.ts";
import type { Run } from "./run.ts";
import { errorMessage, isEnded } from "./shared.ts";

/*
 * Scenarios, at `@sanoma/workflows/scenario`: Gherkin feature files that say what a sandbox run
 * starts from (seeded fake vendors, injected faults), how its approvals are decided, and what it
 * should do. Server-side only, and kept off the main entry so a live worker never loads the
 * Gherkin parser or faker; the worker imports it only for a sandbox run.
 */

setFaker(faker);

/** One step of a scenario, as written, for a list and for marking the graph node it is about. */
export interface ScenarioStep {
  text: string;
  kind: "given" | "when" | "then";
  /** The operation the step is about, when it names one. */
  op?: string;
}

/** A fake's state to seed through one of its operations, or a fault to inject into its next call. */
export type Given =
  | { step: string; op: string; input: unknown }
  | { step: string; op: string; fault: "failNext" | "rateLimit" | "loseReply" };

/** How one approval is decided; `approval` is its title or its id. */
export interface Decision {
  step: string;
  approval: string;
  decision: "approve" | "reject";
  by: string;
  note?: string;
}

/** What the run should do: call an operation (with at least this input) or not, or end a certain way. */
export type Expectation =
  | { step: string; op: string; input?: unknown; called: boolean }
  | { step: string; outcome: "finished" | "failed"; code?: string };

export interface Scenario {
  name: string;
  /** The feature file, relative to the scenarios directory. */
  file: string;
  workflow: string;
  /** The whole feature file, for display. */
  text: string;
  /** Every step in order, for a list and for marking graph nodes. */
  steps: ScenarioStep[];
  given: Given[];
  input: unknown;
  decisions: Decision[];
  expect: Expectation[];
}

const step = z.string();
export const Scenario: z.ZodType<Scenario> = z.object({
  name: z.string(),
  file: z.string(),
  workflow: z.string(),
  text: z.string(),
  steps: z.array(z.object({ text: z.string(), kind: z.enum(["given", "when", "then"]), op: z.string().optional() })),
  given: z.array(
    z.union([
      z.strictObject({ step, op: z.string(), input: z.unknown() }),
      z.strictObject({ step, op: z.string(), fault: z.enum(["failNext", "rateLimit", "loseReply"]) }),
    ]),
  ),
  input: z.unknown(),
  decisions: z.array(
    z.object({
      step,
      approval: z.string(),
      decision: z.enum(["approve", "reject"]),
      by: z.string(),
      note: z.string().optional(),
    }),
  ),
  expect: z.array(
    z.union([
      z.strictObject({ step, op: z.string(), input: z.unknown().optional(), called: z.boolean() }),
      z.strictObject({ step, outcome: z.enum(["finished", "failed"]), code: z.string().optional() }),
    ]),
  ),
});

/** The result of one expectation against a run's ledger. */
export interface Check {
  step: string;
  ok: boolean;
  detail?: string;
}

/** What steps can name: the config's operations and workflows, by id and name. */
export interface Scope {
  ops: Map<string, Op>;
  workflows: Map<string, WorkflowDefinition<any, any>>;
}

type Kind = ScenarioStep["kind"];

/** A scenario being built from its steps. */
interface Draft extends Omit<Scenario, "workflow"> {
  workflow?: string;
}

interface Matched {
  draft: Draft;
  values: unknown[];
  pickle: PickleStep;
}

interface Rule {
  kind: Kind | "any";
  /** The Cucumber expression, as listed in errors. */
  source: string;
  /** What else the step takes, as listed in errors. */
  takes?: string;
  /** For an operation's phrase: its id, which errors list it under. */
  phrase?: string;
  expression: CucumberExpression;
  /** Applies the step to the draft; returns the operation it is about, if any. */
  apply(m: Matched): string | undefined;
}

const KINDS: Partial<Record<PickleStepType, Kind>> = {
  [PickleStepType.CONTEXT]: "given",
  [PickleStepType.ACTION]: "when",
  [PickleStepType.OUTCOME]: "then",
};

const FAULTS = {
  "fails once": "failNext",
  "is rate limited once": "rateLimit",
  "loses its reply once": "loseReply",
} as const;

const unquote = (s: string) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

/** The schema's value with every field `given` does not set made up, parsed by the schema. */
function fill(schema: z.ZodType, given: Record<string, unknown>): unknown {
  return schema.parse({ ...(fake(schema) as object), ...given });
}

/** The step's JSON doc string, parsed. */
function json(pickle: PickleStep): unknown {
  const content = pickle.argument?.docString?.content;
  if (content === undefined) throw new Error(`"${pickle.text}" needs a JSON doc string after it`);
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`the doc string after "${pickle.text}" is not JSON: ${errorMessage(err)}`, { cause: err });
  }
}

/** A JSON object from the step's doc string or its two-column table (values parsed as JSON when they parse). */
function object(pickle: PickleStep): Record<string, unknown> {
  const table = pickle.argument?.dataTable;
  const value = table
    ? Object.fromEntries(
        table.rows.map(({ cells }) => {
          if (cells.length !== 2) throw new Error(`the table after "${pickle.text}" needs two columns: name | value`);
          const [name, raw] = cells.map((c) => c.value) as [string, string];
          try {
            return [name, JSON.parse(raw)];
          } catch {
            return [name, raw];
          }
        }),
      )
    : json(pickle);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`"${pickle.text}" needs a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** The value a phrase captured, as the type the operation's JSON Schema gives the field. */
function coerce(value: string, type: unknown): unknown {
  if (type === "number" || type === "integer") return Number(value);
  if (type === "boolean") return value === "true";
  return value;
}

/** A parameter's transform: the name, when `ids` has it. */
const known = (what: string, ids: Map<string, unknown>) => (name: string) => {
  if (!ids.has(name)) throw new Error(`no ${what} "${name}"; the config has ${[...ids.keys()].toSorted().join(", ")}`);
  return name;
};

const rulesByScope = new WeakMap<Scope, Rule[]>();

/**
 * The steps a feature file may use, with one parameter type registry per scope: the generic
 * steps, and each operation's `phrases`. Throws for a phrase naming a field its operation's
 * input does not have.
 */
function rulesOf(scope: Scope): Rule[] {
  const cached = rulesByScope.get(scope);
  if (cached) return cached;
  const registry = new ParameterTypeRegistry();
  registry.defineParameterType(new ParameterType("op", /\S+/, null, known("operation", scope.ops), false));
  registry.defineParameterType(new ParameterType("workflow", /\S+/, null, known("workflow", scope.workflows), false));
  registry.defineParameterType(new ParameterType("who", /\S+/, null, (s: string) => s, false));

  const rules: Rule[] = [];
  const add = (kind: Rule["kind"], source: string, apply: Rule["apply"], more: Partial<Rule> = {}) =>
    rules.push({ kind, source, expression: new CucumberExpression(source, registry), apply, ...more });
  const opOf = (id: unknown) => scope.ops.get(id as string)!;

  add(
    "given",
    "{op} was called with",
    ({ draft, values: [op], pickle }) => {
      draft.given.push({ step: pickle.text, op: op as string, input: fill(opOf(op).input, object(pickle)) });
      return op as string;
    },
    { takes: "a JSON doc string" },
  );
  for (const [words, fault] of Object.entries(FAULTS)) {
    add("given", `{op} ${words}`, ({ draft, values: [op], pickle }) => {
      draft.given.push({ step: pickle.text, op: op as string, fault });
      return op as string;
    });
  }
  add(
    "when",
    "{workflow} runs with",
    ({ draft, values: [name], pickle }) => runs(draft, name as string, object(pickle)),
    { takes: "a JSON doc string or a two-column table" },
  );
  add("when", "{workflow} runs", ({ draft, values: [name] }) => runs(draft, name as string, {}));
  for (const decision of ["approve", "reject"] as const) {
    const verb = decision === "approve" ? "approved" : "rejected";
    const decide = ({ draft, values: [approval, by, note], pickle }: Matched) => {
      draft.decisions.push({
        step: pickle.text,
        approval: approval as string,
        decision,
        by: by as string,
        ...(note === undefined ? {} : { note: note as string }),
      });
      return undefined;
    };
    add("any", `{string} is ${verb} by {who}`, decide);
    add("any", `{string} is ${verb} by {who} with note {string}`, decide);
  }
  add(
    "then",
    "{op} was called with",
    ({ draft, values: [op], pickle }) => {
      draft.expect.push({ step: pickle.text, op: op as string, input: json(pickle), called: true });
      return op as string;
    },
    { takes: "a JSON doc string" },
  );
  for (const called of [true, false]) {
    add("then", `{op} was ${called ? "" : "not "}called`, ({ draft, values: [op], pickle }) => {
      draft.expect.push({ step: pickle.text, op: op as string, called });
      return op as string;
    });
  }
  add("then", "the run succeeds", ({ draft, pickle }) => {
    draft.expect.push({ step: pickle.text, outcome: "finished" });
    return undefined;
  });
  add("then", "the run fails", ({ draft, pickle }) => {
    draft.expect.push({ step: pickle.text, outcome: "failed" });
    return undefined;
  });
  add("then", "the run fails with {string}", ({ draft, values: [code], pickle }) => {
    draft.expect.push({ step: pickle.text, outcome: "failed", code: code as string });
    return undefined;
  });

  // Each operation's phrases, last: their fields become parameter types the generic steps never use.
  for (const op of scope.ops.values()) {
    const properties = (z.toJSONSchema(op.input, { unrepresentable: "any" }).properties ?? {}) as Record<
      string,
      { type?: unknown }
    >;
    for (const kind of ["given", "then"] as const) {
      const template = op.phrases?.[kind];
      if (template === undefined) continue;
      const fields = [...template.matchAll(/\{([^}]*)\}/g)].map(([, name]) => name!);
      for (const name of fields) {
        if (!Object.hasOwn(properties, name)) {
          throw new Error(
            `${op.id}: its ${kind} phrase "${template}" names {${name}}, which is not a field of its input`,
          );
        }
        if (!registry.lookupByTypeName(name)) {
          registry.defineParameterType(new ParameterType(name, /"[^"]*"|\S+/, null, unquote, false));
        }
      }
      add(
        kind,
        template,
        ({ draft, values, pickle }) => {
          const given = Object.fromEntries(
            fields.map((name, i) => [name, coerce(String(values[i]), properties[name]?.type)]),
          );
          if (kind === "given") draft.given.push({ step: pickle.text, op: op.id, input: fill(op.input, given) });
          else draft.expect.push({ step: pickle.text, op: op.id, input: given, called: true });
          return op.id;
        },
        { phrase: op.id },
      );
    }
  }
  rulesByScope.set(scope, rules);
  return rules;

  function runs(draft: Draft, name: string, given: Record<string, unknown>) {
    if (draft.workflow !== undefined) throw new Error("a second When: a scenario runs its workflow once");
    draft.workflow = name;
    draft.input = fill(scope.workflows.get(name)!.input, given);
    return undefined;
  }
}

/** Every step the scope knows, for an error: the generic ones by keyword, then each operation's phrases under its id. */
function knownSteps(rules: Rule[]): string {
  const keyword = (kind: Rule["kind"]) => (kind === "any" ? "Given/When/Then" : kind[0]!.toUpperCase() + kind.slice(1));
  const line = (r: Rule) => `${keyword(r.kind)} ${r.source}${r.takes ? ` (and ${r.takes})` : ""}`;
  const phrases = new Map<string, string[]>();
  for (const r of rules) if (r.phrase) phrases.set(r.phrase, [...(phrases.get(r.phrase) ?? []), line(r)]);
  return [
    "Known steps:",
    ...rules.filter((r) => !r.phrase).map((r) => `  ${line(r)}`),
    ...[...phrases].flatMap(([op, lines]) => [`  ${op}:`, ...lines.map((l) => `    ${l}`)]),
  ].join("\n");
}

/** The line of every scenario, step and examples row in the document, by AST node id. */
function linesOf(doc: GherkinDocument): Map<string, number> {
  const lines = new Map<string, number>();
  const steps = (list: readonly { id: string; location: { line: number } }[]) =>
    list.forEach((s) => lines.set(s.id, s.location.line));
  for (const child of doc.feature?.children ?? []) {
    for (const c of child.rule ? child.rule.children : [child]) {
      if (c.background) steps(c.background.steps);
      if (c.scenario) {
        lines.set(c.scenario.id, c.scenario.location.line);
        steps(c.scenario.steps);
        for (const ex of c.scenario.examples) steps(ex.tableBody);
      }
    }
  }
  return lines;
}

/** A number from the scenario's name, so one name always makes up the same values. */
const seedOf = (name: string) => createHash("sha256").update(name).digest().readUInt32BE(0);

/**
 * The scenarios in a feature file: one per Gherkin pickle (each row of a `Scenario Outline`'s
 * examples is one). Throws, naming `file:line`, for a step no rule or more than one matches, an
 * unknown operation or workflow, a missing or second `When`, bad JSON, or two scenarios with one name.
 */
export function parseFeature(text: string, file: string, scope: Scope): Scenario[] {
  const rules = rulesOf(scope);
  const newId = IdGenerator.incrementing();
  let doc: GherkinDocument;
  try {
    doc = new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher()).parse(text);
  } catch (err) {
    throw new Error(`${file}: ${errorMessage(err)}`, { cause: err });
  }
  const lines = linesOf(doc);
  const scenarios: Scenario[] = [];
  for (const pickle of compile(doc, file, newId)) {
    const where = (line: number | undefined) => `${file}:${line ?? pickle.location?.line ?? 1}`;
    if (scenarios.some((s) => s.name === pickle.name)) {
      throw new Error(`${where(undefined)}: a second scenario named "${pickle.name}"; give each its own name`);
    }
    const draft: Draft = {
      name: pickle.name,
      file,
      text,
      steps: [],
      given: [],
      input: undefined,
      decisions: [],
      expect: [],
    };
    seed(seedOf(pickle.name));
    for (const ps of pickle.steps) {
      const line = lines.get(ps.astNodeIds[0]!);
      const kind = ps.type && KINDS[ps.type];
      if (!kind) throw new Error(`${where(line)}: "${ps.text}" needs a Given, When or Then before it`);
      const matches = rules.flatMap((rule) => {
        if (rule.kind !== kind && rule.kind !== "any") return [];
        const args = rule.expression.match(ps.text);
        return args ? [{ rule, args }] : [];
      });
      if (matches.length === 0) {
        throw new Error(`${where(line)}: no step matches "${ps.text}"\n${knownSteps(rules)}`);
      }
      if (matches.length > 1) {
        const which = matches.map((m) => `"${m.rule.source}"`).join(" and ");
        throw new Error(`${where(line)}: "${ps.text}" is ambiguous: it matches ${which}`);
      }
      const [{ rule, args }] = matches as [{ rule: Rule; args: readonly Argument[] }];
      try {
        const values = args.map((a) => a.getValue<unknown>(null));
        const op = rule.apply({ draft, values, pickle: ps });
        draft.steps.push({ text: ps.text, kind, ...(op === undefined ? {} : { op }) });
      } catch (err) {
        throw new Error(`${where(line)}: ${errorMessage(err)}`, { cause: err });
      }
    }
    const { workflow } = draft;
    if (workflow === undefined) {
      throw new Error(
        `${where(undefined)}: scenario "${pickle.name}" has no When: say which workflow runs, such as "When <workflow> runs with"`,
      );
    }
    scenarios.push({ ...draft, workflow });
  }
  return scenarios;
}

/**
 * Every scenario in the `.feature` files under `scenarios` (a `file:` URL to a directory),
 * with an error for each file that does not parse and each name used twice. No directory,
 * or none given, is no scenarios. Throws when an operation's phrase names a field it lacks.
 */
export function loadScenarios(scope: Scope & { scenarios?: URL }): {
  scenarios: Scenario[];
  errors: { file: string; message: string }[];
} {
  const scenarios: Scenario[] = [];
  const errors: { file: string; message: string }[] = [];
  if (!scope.scenarios) return { scenarios, errors };
  const dir = fileURLToPath(scope.scenarios);
  if (!existsSync(dir)) return { scenarios, errors };
  rulesOf(scope);
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".feature"))
    .map((f) => f.replaceAll("\\", "/"))
    .toSorted();
  const seen = new Map<string, string>();
  for (const file of files) {
    let parsed: Scenario[];
    try {
      parsed = parseFeature(readFileSync(join(dir, file), "utf8"), file, scope);
    } catch (err) {
      errors.push({ file, message: errorMessage(err) });
      continue;
    }
    for (const s of parsed) {
      const other = seen.get(s.name);
      if (other !== undefined) {
        errors.push({ file, message: `${file}: scenario "${s.name}" is also in ${other}; give each its own name` });
        continue;
      }
      seen.set(s.name, file);
      scenarios.push(s);
    }
  }
  return { scenarios, errors };
}

/** True when `actual` has every key `expected` has, with an equal value, at every depth. */
function contains(actual: unknown, expected: unknown): boolean {
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
    return isDeepStrictEqual(actual, expected);
  }
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([k, v]) => contains((actual as Record<string, unknown>)[k], v));
}

/** Checks each of the scenario's expectations against a run's ledger records. Pure. */
export function check(scenario: Scenario, records: readonly LedgerRecord[]): Check[] {
  const end = records.find((r) => r.type === "run.finished" || r.type === "run.failed");
  return scenario.expect.map((e): Check => {
    if ("op" in e) {
      const calls = records.filter((r) => r.type === "op.called" && r.op === e.op);
      const found = calls.some((r) => e.input === undefined || contains((r as { input: unknown }).input, e.input));
      const ok = found === e.called;
      if (ok) return { step: e.step, ok };
      const what = e.input === undefined ? e.op : `${e.op} with ${JSON.stringify(e.input)}`;
      return {
        step: e.step,
        ok,
        detail: e.called
          ? `no call to ${what}${calls.length ? `; its calls had ${calls.map((r) => JSON.stringify((r as { input: unknown }).input)).join(", ")}` : ""}`
          : `${e.op} was called`,
      };
    }
    if (!end) return { step: e.step, ok: false, detail: "run not ended" };
    if (e.outcome === "finished") {
      return end.type === "run.finished"
        ? { step: e.step, ok: true }
        : { step: e.step, ok: false, detail: `the run failed: ${end.error.message}` };
    }
    if (end.type !== "run.failed") return { step: e.step, ok: false, detail: "the run finished" };
    if (e.code === undefined || end.error.code === e.code) return { step: e.step, ok: true };
    return {
      step: e.step,
      ok: false,
      detail: `the run failed with ${end.error.code ?? "no code"}: ${end.error.message}`,
    };
  });
}

/**
 * Decides the run's approvals as the scenario says until the run ends, and returns how it
 * ended. Each pending approval takes the decision naming its title (or id), else the next one
 * left in order; one with no decision left throws.
 */
export async function drive(
  client: SanomaClient,
  runId: string,
  scenario: Scenario,
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {},
): Promise<RunSummary> {
  const left = [...scenario.decisions];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await client.run(runId);
    if (!run) throw new SanomaError("run_not_found", `No run ${runId}`, { runId });
    if (isEnded(run.status)) return run;
    for (const approval of run.approvals.filter((a) => a.status === "pending")) {
      const named = left.findIndex((d) => d.approval === approval.title || d.approval === approval.id);
      const [d] = left.splice(named === -1 ? 0 : named, 1);
      if (!d) {
        throw new Error(`Scenario "${scenario.name}" has no decision for "${approval.title}" (${approval.id})`);
      }
      const note = d.note === undefined ? {} : { note: d.note };
      await client.decide(runId, { decision: d.decision, by: { id: d.by }, ...note }, approval.id);
    }
    if (Date.now() > deadline) {
      throw new SanomaError("run_running", `Run ${runId} is still running after ${timeoutMs} ms`, {
        runId,
        timeoutMs,
      });
    }
    await delay(100);
  }
}

/**
 * Seeds the fakes for a sandbox run of the scenario `name`, from the worker: once, in a step,
 * so a replay never seeds twice. Refuses while another sandbox run holds the worker's fakes.
 * Resets every fake, calls each `Given` operation through its fake, then injects the faults,
 * and empties the call log, so it holds the run's calls only.
 */
export async function seedSandbox(run: Run, name: string): Promise<void> {
  const { state } = run;
  const { scenarios, errors } = loadScenarios({
    ops: state.ops,
    workflows: state.workflows,
    scenarios: state.scenarios,
  });
  const scenario = scenarios.find((s) => s.name === name);
  if (!scenario) {
    const why = errors.length ? `; these files did not load: ${errors.map((e) => e.message).join("; ")}` : "";
    throw new SanomaError("invalid_input", `No scenario named "${name}"${why}`, { scenario: name });
  }
  if (scenario.workflow !== run.workflow) {
    throw new SanomaError("invalid_input", `Scenario "${name}" runs ${scenario.workflow}, not ${run.workflow}`, {
      scenario: name,
      workflow: scenario.workflow,
    });
  }
  const { seeds } = await DBOS.runStep(
    async () => {
      if (state.sandboxRun !== undefined && state.sandboxRun !== run.id) {
        throw new SanomaError(
          "sandbox_busy",
          `Sandbox run ${state.sandboxRun} is still using the fakes; start another once it ends`,
          { runId: state.sandboxRun },
        );
      }
      state.sandboxRun = run.id;
      for (const f of state.fakes) f.reset();
      const fakeOf = (id: string) => {
        const op = state.ops.get(id)!;
        const owner = state.fakes.find((f) => f.driver.vendor === op.vendor);
        if (!owner)
          throw new SanomaError("invalid_input", `No fake for ${id}: add its vendor's fake to the config's \`fakes\``);
        return { op, fake: owner };
      };
      const seeded: { op: string; input: unknown; output: unknown }[] = [];
      for (const [i, given] of scenario.given.entries()) {
        if (!("input" in given)) continue;
        const { op, fake: owner } = fakeOf(given.op);
        const call = { idempotencyKey: `${run.id}:seed:${i}`, runId: run.id, opId: op.id, attempt: 1 };
        const output = await owner.driver.ops[`${op.resource}.${op.name}`]!(given.input, call);
        seeded.push({ op: op.id, input: given.input, output });
      }
      for (const given of scenario.given) if ("fault" in given) fakeOf(given.op).fake[given.fault](given.op);
      for (const f of state.fakes) f.calls.splice(0);
      return { seeds: seeded };
    },
    { name: "sandbox:seed" },
  );
  await write(run, entry(run, { type: "scenario.seeded", scenario: name, seeds }));
}
