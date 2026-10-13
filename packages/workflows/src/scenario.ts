import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { ParameterTypeRegistry } from "@cucumber/cucumber-expressions";
import { AstBuilder, compile as compilePickles, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin";
import {
  type GherkinDocument,
  IdGenerator,
  type Pickle,
  type PickleStep,
  PickleStepType,
  type Step as GherkinStep,
} from "@cucumber/messages";
import type { z } from "zod";
import type { RunSummary, SanomaClient } from "./client.ts";
import type { ResolvedConfig } from "./config.ts";
import {
  buildLibrary,
  type Library,
  type ParameterTypeSpec,
  type Report,
  runFeatures,
  type SanomaWorld,
  StepStatus,
} from "./cucumber.ts";
import type { Approver } from "./define.ts";
import type { DriftReport, DriftResult } from "./drift.ts";
import { errorInfo, SanomaError } from "./errors.ts";
import type { Fake } from "./fake.ts";
import { fill, isBug, seedFrom, shapeOf } from "./fill.ts";
import type { LedgerRecord } from "./ledger.ts";
import type { Driver } from "./op.ts";
import { type OutlineNode, outlineWorkflow } from "./outline.ts";
import type { RecordedDecision } from "./policy.ts";
import { approverLabel, DRIFT_WORKFLOW, errorMessage, isEnded } from "./shared.ts";
import { type CallRecord, type Fault, opId, type RunView, type StepArgument } from "./steps.ts";

/*
 * Scenarios, at `@sanoma/workflows/scenario`: Gherkin feature files that say what a sandbox run
 * starts from (seeded fake vendors, injected faults), how its approvals are decided, and what it
 * should do. Cucumber runs them (`cucumber.ts`), in two ways: compiling a feature file into
 * scenarios, where the steps only record what they say, and checking a run's ledger against one,
 * where only its `Then` steps run, as assertions. A connector's own feature files run a third
 * way, calling its operations directly (`testFeature`). Server-side only, and kept off the main
 * entry so a live worker never loads Cucumber or faker; the worker imports it (through
 * `sandbox.ts`) only for a sandbox run.
 */

/** One step of a scenario, as written, for a list and for marking the graph node it is about. */
export interface ScenarioStep {
  text: string;
  kind: "given" | "when" | "then";
  /** The operation the step is about, when it names one. */
  op?: string;
  /** For a `Then` step about an operation: true when it expects a call, false for `was not called`. */
  called?: boolean;
  /** For a `Then` step about the policy's decision on an operation: `was denied`, or `was held for`. */
  decision?: "denied" | "held";
  /** For a `Given` that injects a fault into the operation's next call (`fails once` and the like), rather than seeding it. */
  fault?: true;
}

/**
 * A fake's state to seed through one of its operations (`as` names what the call returns, for
 * an operation's own test), a fault to inject into its next call, or an object a vendor's fake
 * holds: `resource` is its type's id (`github.repository`, its `vendor` and `type`) and `name`
 * its import id, with `fields` to set on it (put, when the vendor has none) or `gone` to remove it.
 */
export type Given =
  | { step: string; op: string; input: unknown; as?: string }
  | { step: string; op: string; fault: Fault }
  | { step: string; resource: string; vendor: string; type: string; name: string; fields: Record<string, unknown> }
  | { step: string; resource: string; vendor: string; type: string; name: string; gone: true };

/** How one approval is decided; `approval` is its title or its id. */
export interface Decision {
  step: string;
  approval: string;
  decision: "approve" | "reject";
  by: string;
  note?: string;
}

/**
 * What the run should do: call an operation (with at least this input) or not, have the policy
 * deny one (`denied`) or hold one for an approver (`held`), end a certain way, or, for a drift
 * run, report the resource `declared` (`<file>#<export>`) clean, gone, or drifted in a field.
 * A step whose own code checks the run says whose steps it is (`owner`: a connector's vendor,
 * the company's, or `sanoma` for the steps of an operation's own tests), and what it is about.
 */
export type Expectation =
  | { step: string; op: string; input?: unknown; called: boolean }
  | { step: string; op: string; decision: "denied" }
  | { step: string; op: string; decision: "held"; approver: string }
  | { step: string; outcome: "finished" | "failed"; code?: string }
  | { step: string; declared: string; status: "clean" | "gone" }
  | { step: string; declared: string; status: "drifted"; field: string }
  | { step: string; owner: string; op?: string; called?: boolean };

export interface Scenario {
  name: string;
  /** The feature file, relative to the scenarios directory. */
  file: string;
  /** Its line in the file: its keyword's, or for an outline's row, the row's. */
  line: number;
  workflow: string;
  /**
   * The scenario's own lines of its feature file, for display: from its keyword line to the end
   * of its last step (a step's doc string or table included, and an outline's examples), less
   * the keyword line's indent. An outline's rows share their outline's.
   */
  text: string;
  /** Every step in order, for a list and for marking graph nodes. */
  steps: ScenarioStep[];
  given: Given[];
  input: unknown;
  decisions: Decision[];
  /**
   * The titles of the approvals the workflow's code asks for, where a title is a string literal
   * (read from its outline), so `drive` can tell a decision for an approval still to come from
   * one meant for whichever comes next.
   */
  approvals: string[];
  expect: Expectation[];
}

/** The result of one expectation against a run's ledger. */
export interface Check {
  step: string;
  ok: boolean;
  detail?: string;
}

/**
 * What steps can name: the config's operations, workflows and resource types by id, the steps
 * its connectors (and the company) ship, and where the feature files are.
 */
export type Scope = Pick<ResolvedConfig, "ops" | "workflows" | "scenarios" | "types" | "steps">;

type Kind = ScenarioStep["kind"];
type Unstepped<T> = T extends unknown ? Omit<T, "step"> : never;
type Unexpressed<T> = T extends unknown ? Omit<T, "expression"> : never;

/** What a `When` says: which workflow runs, on what; or, in an operation's own test, a call to make. */
type When = { workflow: string; input: unknown } | { call: string; input: Record<string, unknown> };

/** What a `Then` says: its expectation, and how to check it against a run. */
interface Then {
  expect: Unstepped<Expectation>;
  verify(run: RunView): string | undefined;
}

/** What a step of each kind reads into; `any` is a decision, which a step of any keyword may make. */
interface Items {
  given: Unstepped<Given>[];
  when: When;
  then: Then;
  any: Unstepped<Decision>;
}

type Rule = {
  [K in keyof Items]: {
    kind: K;
    /** The step as listed in errors: its Cucumber expression, or an operation's phrase as written. */
    source: string;
    /** The Cucumber expression it is registered with. */
    expression: string;
    /** What else the step takes, as listed in errors. */
    takes?: string;
    /** Whose step it is, which errors list it under: an operation's id for its phrase, or a step library's owner. */
    group?: string;
    /** What the step says, from the expression's values and the step's doc string or table. */
    read(values: unknown[], pickle: PickleStep): Items[K];
  };
}[keyof Items];

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

/** The schema of the field `name` of an object schema (`owner`, for the error); throws naming the fields it has. */
function fieldOf(schema: z.ZodType, name: string, owner: string): z.ZodType {
  const shape = shapeOf(schema);
  if (!Object.hasOwn(shape, name)) {
    throw new Error(`no field "${name}" in ${owner}; it has ${Object.keys(shape).join(", ") || "none"}`);
  }
  return shape[name]!;
}

const issues = (error: z.ZodError) => error.issues.map((i) => i.message).join("; ");

/**
 * The value text from a table cell or a phrase gives a field: the text itself when the field
 * takes it, else the text read as JSON (a number, `true`, a list) when the field takes that.
 */
function valueFor(field: z.ZodType, text: string, what: string): unknown {
  const asText = field.safeParse(text);
  if (asText.success) return text;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${what} cannot be ${JSON.stringify(text)}: ${issues(asText.error)}`);
  }
  const asJson = field.safeParse(json);
  if (!asJson.success) throw new Error(`${what} cannot be ${text}: ${issues(asJson.error)}`);
  return json;
}

/**
 * The fields the step's doc string (a JSON object) or two-column table gives `owner` (an
 * operation's input, or a resource), each checked against its field in `schema`: a field it
 * lacks, or a value it refuses, is an error.
 */
function fieldsFrom(pickle: PickleStep, schema: z.ZodType, owner: string): Record<string, unknown> {
  const { docString, dataTable } = pickle.argument ?? {};
  const what = (name: string) => `${name} in ${owner}`;
  if (dataTable) {
    return Object.fromEntries(
      dataTable.rows.map(({ cells }) => {
        if (cells.length !== 2) throw new Error(`the table after "${pickle.text}" needs two columns: name | value`);
        const [name, text] = cells.map((c) => c.value) as [string, string];
        return [name, valueFor(fieldOf(schema, name, owner), text, what(name))];
      }),
    );
  }
  if (!docString) throw new Error(`"${pickle.text}" needs a JSON doc string or a two-column table after it`);
  let value: unknown;
  try {
    value = JSON.parse(docString.content);
  } catch (err) {
    throw new Error(`the doc string after "${pickle.text}" is not JSON: ${errorMessage(err)}`, { cause: err });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`"${pickle.text}" needs a JSON object`);
  }
  for (const [name, v] of Object.entries(value)) {
    const parsed = fieldOf(schema, name, owner).safeParse(v);
    if (!parsed.success) throw new Error(`${what(name)} cannot be ${JSON.stringify(v)}: ${issues(parsed.error)}`);
  }
  return value as Record<string, unknown>;
}

/** The step's doc string or table, as a step library's function receives it. */
function argumentOf(pickle: PickleStep): StepArgument | undefined {
  const { docString, dataTable } = pickle.argument ?? {};
  if (docString) return { docString: docString.content };
  if (dataTable) return { table: dataTable.rows.map((r) => r.cells.map((c) => c.value)) };
  return undefined;
}

/** A parameter's transform: the name, when `ids` has it. */
const known = (what: string, ids: ReadonlyMap<string, unknown>) => (name: string) => {
  if (!ids.has(name)) throw new Error(`no ${what} "${name}"; the config has ${[...ids.keys()].toSorted().join(", ")}`);
  return name;
};

const TAKES_OBJECT = "a JSON doc string or a two-column table";

/** What a field belongs to, in errors: an operation's or a workflow's input. */
const inputOf = (name: unknown) => `${name as string}'s input`;

/** Whose steps the steps for an operation's own tests are, in an expectation. */
const CORE = "sanoma";

/** A step's verdict: passed when there is no `detail`. */
const verdict = (step: string, detail?: string): Check =>
  detail === undefined ? { step, ok: true } : { step, ok: false, detail };

/** The rules and the parameter types for one scope, and the Cucumber library built from them. */
interface Built {
  scope: Scope;
  rules: Rule[];
  /** The rules by the expression they are registered with, in the library's order. */
  byExpression: Rule[][];
  library: Library;
  known: string;
}

/** By the scope's operations, which every scope of one resolved config shares. */
const builtByOps = new WeakMap<object, Built>();

/**
 * The steps a feature file may use in a scope, and the Cucumber library that runs them: the
 * generic steps, the steps of an operation's own tests, each step library's steps, and each
 * operation's `phrases`, compiled into steps. Throws for a phrase naming a field its operation's
 * input does not have.
 */
function builtFor(scope: Scope): Built {
  const cached = builtByOps.get(scope.ops);
  if (
    cached &&
    cached.scope.workflows === scope.workflows &&
    cached.scope.types === scope.types &&
    cached.scope.steps === scope.steps
  ) {
    return cached;
  }
  const { rules, parameterTypes } = rulesOf(scope);
  const groups = Map.groupBy(rules, (r) => r.expression);
  const library = buildLibrary(parameterTypes, [...groups.keys()]);
  const built: Built = { scope, rules, byExpression: [...groups.values()], library, known: knownSteps(rules) };
  builtByOps.set(scope.ops, built);
  return built;
}

/** A `Then` step of the generic steps: its expectation, checked against the run's records. */
const expecting = (expect: CoreExpectation): Then => ({ expect, verify: (run) => detailOf(expect, run.records) });

/** The rules a scope has, and the parameter types their expressions use. */
function rulesOf(scope: Scope): { rules: Rule[]; parameterTypes: ParameterTypeSpec[] } {
  const { types } = scope;
  const parameterTypes: ParameterTypeSpec[] = [
    { name: "op", regexp: /\S+/, transformer: known("operation", scope.ops) },
    { name: "workflow", regexp: /\S+/, transformer: known("workflow", scope.workflows) },
    { name: "who", regexp: /\S+/, transformer: (s) => s },
    { name: "resource", regexp: /\S+/, transformer: known("resource type", types) },
    // A declared resource, as a drift report names it: `<file>#<export>`.
    { name: "declared", regexp: /[^\s#]+#\S+/, transformer: (s) => s },
    { name: "field", regexp: /\S+/, transformer: (s) => s },
  ];
  const opOf = (id: unknown) => scope.ops.get(id as string)!;
  const workflowOf = (name: unknown) => scope.workflows.get(name as string)!;
  /** A resource step's object: its type's id, vendor and type, and its import id. */
  const object = (id: unknown, name: unknown) => {
    const { vendor, type } = types.get(id as string)!;
    return { resource: id as string, vendor, type, name: name as string };
  };
  /** A generic rule, registered with its own source. */
  const generic = (rule: Unexpressed<Rule>) => ({ ...rule, expression: rule.source }) as Rule;

  const rules: Rule[] = [
    generic({
      kind: "given",
      source: "{op} was called with",
      takes: TAKES_OBJECT,
      read: ([op], pickle) => [
        { op: op as string, input: fill(opOf(op).input, fieldsFrom(pickle, opOf(op).input, inputOf(op))) },
      ],
    }),
    ...Object.entries(FAULTS).map(([words, fault]) =>
      generic({ kind: "given", source: `{op} ${words}`, read: ([op]) => [{ op: op as string, fault }] }),
    ),
    generic({
      kind: "given",
      source: "{resource} {string} has",
      takes: TAKES_OBJECT,
      read: ([resource, name], pickle) => [
        {
          ...object(resource, name),
          fields: fieldsFrom(
            pickle,
            types.get(resource as string)!.schema,
            `${resource as string} "${name as string}"`,
          ),
        },
      ],
    }),
    generic({
      kind: "given",
      source: "{resource} {string} is gone",
      read: ([resource, name]) => [{ ...object(resource, name), gone: true }],
    }),
    generic({
      kind: "when",
      source: "{workflow} runs with",
      takes: TAKES_OBJECT,
      read: ([name], pickle) => {
        const { input } = workflowOf(name);
        return { workflow: name as string, input: fill(input, fieldsFrom(pickle, input, inputOf(name))) };
      },
    }),
    generic({
      kind: "when",
      source: "{workflow} runs",
      read: ([name]) => ({ workflow: name as string, input: fill(workflowOf(name).input, {}) }),
    }),
    // An operation's own test: a call made to its driver, or its fake, directly.
    generic({
      kind: "when",
      source: "{op} is called with",
      takes: TAKES_OBJECT,
      read: ([op], pickle) => ({
        call: op as string,
        input: fill(opOf(op).input, fieldsFrom(pickle, opOf(op).input, inputOf(op))) as Record<string, unknown>,
      }),
    }),
    ...(["approve", "reject"] as const).flatMap((decision) => {
      const verb = decision === "approve" ? "approved" : "rejected";
      return [`{string} is ${verb} by {who}`, `{string} is ${verb} by {who} with note {string}`].map((source) =>
        generic({
          kind: "any",
          source,
          read: ([approval, by, note]) => ({
            approval: approval as string,
            decision,
            by: by as string,
            ...(note === undefined ? {} : { note: note as string }),
          }),
        }),
      );
    }),
    generic({
      kind: "then",
      source: "{op} was called with",
      takes: TAKES_OBJECT,
      read: ([op], pickle) =>
        expecting({ op: op as string, input: fieldsFrom(pickle, opOf(op).input, inputOf(op)), called: true }),
    }),
    ...[true, false].map((called) =>
      generic({
        kind: "then",
        source: `{op} was ${called ? "" : "not "}called`,
        read: ([op]) => expecting({ op: op as string, called }),
      }),
    ),
    generic({
      kind: "then",
      source: "{op} was denied",
      read: ([op]) => expecting({ op: op as string, decision: "denied" }),
    }),
    generic({
      kind: "then",
      source: "{op} was held for {who}",
      read: ([op, who]) => expecting({ op: op as string, decision: "held", approver: who as string }),
    }),
    generic({
      kind: "then",
      source: "{declared} is drifted in {field}",
      read: ([declared, field]) =>
        expecting({ declared: declared as string, status: "drifted", field: field as string }),
    }),
    ...(["clean", "gone"] as const).map((status) =>
      generic({
        kind: "then",
        source: `{declared} is ${status}`,
        read: ([declared]) => expecting({ declared: declared as string, status }),
      }),
    ),
    generic({ kind: "then", source: "the run succeeds", read: () => expecting({ outcome: "finished" }) }),
    generic({ kind: "then", source: "the run fails", read: () => expecting({ outcome: "failed" }) }),
    generic({
      kind: "then",
      source: "the run fails with {string}",
      read: ([code]) => expecting({ outcome: "failed", code: code as string }),
    }),
    // The result of the last call: what an operation's own test checks.
    generic({
      kind: "then",
      source: "it returns",
      takes: "a JSON doc string or a two-column table, of fields of its output",
      read: (_, pickle) => ({
        expect: { owner: CORE },
        verify: ({ records }) => {
          const last = lastCall(records);
          if (typeof last === "string") return last;
          if (last.error) return `it failed: ${last.error.code ?? last.error.name}: ${last.error.message}`;
          const expected = fieldsFrom(pickle, opOf(last.op).output, `${last.op}'s output`);
          return contains(last.output, expected) ? undefined : `it returned ${JSON.stringify(last.output)}`;
        },
      }),
    }),
    generic({
      kind: "then",
      source: "it fails with status {int}",
      read: ([status]) => ({
        expect: { owner: CORE },
        verify: ({ records }) => {
          const last = lastCall(records);
          if (typeof last === "string") return last;
          if (!last.error) return `it returned ${JSON.stringify(last.output)}`;
          if (last.error.status === status) return undefined;
          return `it failed with ${last.error.status === undefined ? "no status" : `status ${last.error.status}`}: ${last.error.message}`;
        },
      }),
    }),
  ];

  // Each step library's steps, after the generic ones.
  for (const { owner, steps } of scope.steps) {
    for (const def of steps) {
      const base = { source: def.expression, expression: def.expression, group: owner };
      if (def.kind === "given") {
        rules.push({
          ...base,
          kind: "given",
          read: (values, pickle) =>
            [def.fn(...values, argumentOf(pickle))].flat().map((seed) => {
              const op = known("operation", scope.ops)(opId(seed.op));
              if ("fault" in seed) return { op, fault: seed.fault };
              let input: unknown;
              try {
                input = fill(opOf(op).input, seed.input);
              } catch (err) {
                if (isBug(err)) throw err;
                throw new Error(`${inputOf(op)} cannot be ${JSON.stringify(seed.input)}: ${errorMessage(err)}`, {
                  cause: err,
                });
              }
              return { op, input, ...(seed.as === undefined ? {} : { as: seed.as }) };
            }),
        });
        continue;
      }
      rules.push({
        ...base,
        kind: "then",
        read: (values, pickle) => {
          const expected = def.fn(...values, argumentOf(pickle));
          const op = expected.op === undefined ? undefined : known("operation", scope.ops)(opId(expected.op));
          return {
            expect: {
              owner,
              ...(op === undefined ? {} : { op }),
              ...(expected.called === undefined ? {} : { called: expected.called }),
            },
            verify: (run) => {
              const detail = expected.check(run);
              return typeof detail === "string" ? detail : undefined;
            },
          };
        },
      });
    }
  }

  // Each operation's phrases, last. A field `{title}` becomes the parameter type `{field_title}`,
  // so a field named like another type (`op`, `string`, `int`) never takes that type's pattern.
  // It matches what `{string}` does, or one word, and unquotes the same way.
  const string = new ParameterTypeRegistry().lookupByTypeName("string")!;
  const word = /([^\s"']\S*)/;
  const field = (groups: string[]) => groups.at(-1) ?? string.transform(null, groups.slice(0, -1));
  const fieldTypes = new Set<string>();
  for (const op of scope.ops.values()) {
    // A phrase's key, and the keyword of the steps it adds.
    for (const [key, kind] of [
      ["given", "given"],
      ["expect", "then"],
    ] as const) {
      const template = op.phrases?.[key];
      if (template === undefined) continue;
      const fields = [...template.matchAll(/\{([^}]*)\}/g)].map(([, name]) => name!);
      const schemas = fields.map((name) => {
        try {
          return fieldOf(op.input, name, inputOf(op.id));
        } catch {
          throw new Error(
            `${op.id}: its ${key} phrase "${template}" names {${name}}, which is not a field of its input`,
          );
        }
      });
      for (const name of fields) {
        if (fieldTypes.has(name)) continue;
        fieldTypes.add(name);
        parameterTypes.push({
          name: `field_${name}`,
          regexp: [...string.regexpStrings, word.source],
          transformer: (...g) => field(g),
        });
      }
      const given = (values: unknown[]) =>
        Object.fromEntries(
          fields.map((name, i) => [name, valueFor(schemas[i]!, values[i] as string, `${name} in ${inputOf(op.id)}`)]),
        );
      const common = { source: template, group: op.id, expression: template.replaceAll(/\{([^}]*)\}/g, "{field_$1}") };
      rules.push(
        kind === "given"
          ? { ...common, kind, read: (values) => [{ op: op.id, input: fill(op.input, given(values)) }] }
          : { ...common, kind, read: (values) => expecting({ op: op.id, input: given(values), called: true }) },
      );
    }
  }
  return { rules, parameterTypes };
}

/** The last call of a run, or why there is none to check. */
function lastCall(records: readonly LedgerRecord[]): CallRecord | string {
  return records.findLast(isCall) ?? "no call was made";
}

/** Every step the scope knows, for an error: the generic ones by keyword, then each operation's phrases and each step library's steps under its name. */
function knownSteps(rules: Rule[]): string {
  const keyword = (kind: Rule["kind"]) => (kind === "any" ? "Given/When/Then" : kind[0]!.toUpperCase() + kind.slice(1));
  const line = (r: Rule) => `${keyword(r.kind)} ${r.source}${r.takes ? ` (and ${r.takes})` : ""}`;
  const { generic = [], ...groups } = Object.groupBy(rules, (r) => r.group ?? "generic");
  return [
    "Known steps:",
    ...generic.map((r) => `  ${line(r)}`),
    ...Object.entries(groups).flatMap(([group, list]) => [`  ${group}:`, ...(list ?? []).map((r) => `    ${line(r)}`)]),
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

/**
 * Each scenario's own lines of the file, by AST node id: from its keyword line to the end of its
 * last step (the closing delimiter of a doc string, the last row of a table) or of its examples'
 * last row, each line less the keyword line's indent.
 */
function textsOf(doc: GherkinDocument, text: string): Map<string, string> {
  const lines = text.split(/\r?\n/);
  const endOf = (step: GherkinStep): number => {
    if (step.dataTable) return step.dataTable.rows.at(-1)?.location.line ?? step.location.line;
    if (!step.docString) return step.location.line;
    // Line numbers count from 1, so index `line` is the line after the opening delimiter.
    const { location, delimiter } = step.docString;
    const close = lines.findIndex((l, i) => i >= location.line && l.trim() === delimiter);
    return close === -1 ? location.line : close + 1;
  };
  const texts = new Map<string, string>();
  for (const child of doc.feature?.children ?? []) {
    for (const { scenario } of child.rule ? child.rule.children : [child]) {
      if (!scenario) continue;
      const { line, column = 1 } = scenario.location;
      const end = Math.max(
        line,
        ...scenario.steps.map(endOf),
        ...scenario.examples.map((ex) => (ex.tableBody.at(-1) ?? ex.tableHeader ?? ex).location.line),
      );
      const own = lines.slice(line - 1, end).map((l) => l.slice(Math.min(column - 1, l.length - l.trimStart().length)));
      texts.set(scenario.id, own.join("\n"));
    }
  }
  return texts;
}

const approvalsByWorkflow = new WeakMap<object, string[]>();

/** The titles of the approvals in an outline, at any depth, where they are string literals. */
const titles = (nodes: OutlineNode[]): string[] =>
  nodes.flatMap((n) => {
    if (n.kind === "approval") return n.title === undefined ? [] : [n.title];
    if (n.kind === "all") return n.branches.flatMap(titles);
    if (n.kind === "branch") return n.cases.flatMap(titles);
    return n.kind === "each" || n.kind === "repeat" ? titles(n.body) : [];
  });

/** The literal titles of the approvals a workflow's code asks for, from its outline. */
function approvalsOf(wf: Parameters<typeof outlineWorkflow>[0]): string[] {
  let found = approvalsByWorkflow.get(wf);
  if (!found) {
    const outline = outlineWorkflow(wf);
    found = "nodes" in outline ? [...new Set(titles(outline.nodes))] : [];
    approvalsByWorkflow.set(wf, found);
  }
  return found;
}

const namesByReport = new WeakMap<Report, Map<string, string>>();

/**
 * The name of each pickle of a run, by its id: its own, or for an outline's rows whose names
 * would be the same, its own with its row's line (`Launch (line 12)`).
 */
function namesOf(report: Report): Map<string, string> {
  const cached = namesByReport.get(report);
  if (cached) return cached;
  const names = new Map<string, string>();
  namesByReport.set(report, names);
  for (const [uri, inFile] of Map.groupBy(report.pickles, (p) => p.uri)) {
    const doc = report.sources.get(uri)?.document;
    const lines = doc ? linesOf(doc) : new Map<string, number>();
    const counts = Map.groupBy(inFile, (p) => p.name);
    for (const pickle of inFile) {
      const row = pickle.astNodeIds[1];
      const shared = row !== undefined && counts.get(pickle.name)!.length > 1;
      names.set(pickle.id, shared ? `${pickle.name} (line ${lines.get(row)})` : pickle.name);
    }
  }
  return names;
}

/** A pickle's line: its scenario's, or its examples row's. */
const lineOf = (pickle: Pickle, lines: ReadonlyMap<string, number>) =>
  lines.get(pickle.astNodeIds[1] ?? pickle.astNodeIds[0]!) ?? 1;

/** What one scenario's steps said, as compiling it records them. */
type Spec = Omit<Scenario, "workflow" | "approvals" | "file" | "line" | "text"> & { workflow?: string };

/** The run's records, as a `Then` step reads them. */
function viewOf(records: readonly LedgerRecord[]): RunView {
  return {
    records,
    calls: (op) => records.filter((r): r is CallRecord => isCall(r) && r.op === opId(op) && !r.error),
    seeded: (op) =>
      records.flatMap((r) =>
        r.type === "scenario.seeded"
          ? r.seeds.flatMap((s) => ("op" in s && s.op === opId(op) ? [{ input: s.input, output: s.output }] : []))
          : [],
      ),
  };
}

/** Where an operation's own test makes its calls: an operation's driver, live, replayed or a fake's, and the fake. */
export interface FeatureTarget {
  driver: Driver;
  /** The fake whose driver it is: a scenario's faults need one. */
  fake?: Fake<any, any>;
}

/** How a run treats its steps: compiling them, checking a run's ledger, or calling an operation directly. */
type Mode =
  | { kind: "compile"; specs: Map<string, Spec> }
  | { kind: "check"; view: RunView }
  | { kind: "test"; target: FeatureTarget };

/**
 * The rule a step's keyword picks among those registered with the expression it matched:
 * Cucumber matches the text alone, so one expression can be both a `Given` and a `Then`.
 */
function ruleFor(built: Built, expression: number, pickle: PickleStep): Rule {
  const kind = pickle.type && KINDS[pickle.type];
  if (!kind) throw new Error(`"${pickle.text}" needs a Given, When or Then before it`);
  const rules = built.byExpression[expression]!.filter((r) => r.kind === kind || r.kind === "any");
  if (rules.length === 0) throw new Error(`no step matches "${pickle.text}"\n${built.known}`);
  if (rules.length > 1) {
    const which = rules.map((r) => `"${r.source}"`).join(" and ");
    throw new Error(`"${pickle.text}" is ambiguous: it matches ${which}`);
  }
  return rules[0]!;
}

/**
 * A World for one scenario of a run in `mode`, each step run by its rule (`ruleFor`).
 */
function worldFor(built: Built, mode: Mode) {
  return (report: Report): SanomaWorld => {
    let spec: Spec | undefined;
    // An operation's own test: what its steps named, and the calls it made.
    const values = new Map<string, unknown>();
    const records: LedgerRecord[] = [];
    let seq = 0;
    let pickleId = "";
    /** Calls an operation on the target, as the runtime would: the input parsed by its schema. */
    const call = async (id: string, given: unknown) => {
      const op = built.scope.ops.get(id)!;
      const input = op.input.parse(resolve(given, values));
      const fn = mode.kind === "test" ? mode.target.driver.ops[`${op.resource}.${op.name}`] : undefined;
      if (!fn) throw new Error(`the driver under test does not implement ${id}`);
      const context = { idempotencyKey: `${pickleId}:${++seq}`, runId: pickleId, opId: id, attempt: 1 };
      return { op, input, output: () => fn(input, context) };
    };
    return {
      begin(pickle) {
        const names = namesOf(report);
        pickleId = pickle.id;
        // One name always makes up the same values.
        seedFrom(names.get(pickle.id) ?? pickle.name);
        if (mode.kind === "compile") {
          spec = { name: names.get(pickle.id)!, steps: [], given: [], input: undefined, decisions: [], expect: [] };
          mode.specs.set(pickle.id, spec);
        }
      },
      async step(expression, args, pickle) {
        const rule = ruleFor(built, expression, pickle);
        const text = pickle.text;
        if (mode.kind === "check") {
          if (rule.kind !== "then") return;
          const detail = rule.read(args, pickle).verify(mode.view);
          if (detail !== undefined) throw new Error(detail);
          return;
        }
        if (mode.kind === "test") {
          switch (rule.kind) {
            case "given": {
              const seeded: { op: string; input: unknown; output: unknown }[] = [];
              for (const item of rule.read(args, pickle)) {
                if ("resource" in item) throw new Error(`"${text}" seeds a resource: a step for a sandbox run`);
                if ("fault" in item) {
                  const { fake } = mode.target;
                  if (!fake)
                    throw new Error(`"${text}" injects a fault, which only a fake can: tag the scenario @fake-only`);
                  fake[item.fault](item.op);
                  continue;
                }
                const made = await call(item.op, item.input);
                const output = await made.output();
                if (item.as !== undefined) values.set(item.as, output);
                seeded.push({ op: item.op, input: made.input, output });
              }
              if (seeded.length) records.push(record({ type: "scenario.seeded", scenario: "", seeds: seeded }));
              return;
            }
            case "when": {
              const item = rule.read(args, pickle);
              if ("workflow" in item) {
                throw new Error(
                  `"${text}" runs a workflow: a step for a scenario in scenarios/, not an operation's own test`,
                );
              }
              const made = await call(item.call, item.input);
              const started = Date.now();
              const result = await made.output().then(
                (output) => ({ output }),
                (err: unknown) => {
                  if (isBug(err)) throw err;
                  return { error: errorInfo(err) };
                },
              );
              records.push(
                record({
                  type: "op.called",
                  op: made.op.id,
                  effect: made.op.effect,
                  input: made.input,
                  decision: { kind: "allow" },
                  durationMs: Date.now() - started,
                  ...result,
                }),
              );
              return;
            }
            case "any":
              throw new Error(
                `"${text}" decides an approval: a step for a scenario in scenarios/, not an operation's own test`,
              );
            case "then": {
              const detail = rule.read(args, pickle).verify(viewOf(records));
              if (detail !== undefined) throw new Error(detail);
              return;
            }
          }
        }
        // Compiling: record what the step says.
        const s = spec!;
        const step: ScenarioStep = { text, kind: KINDS[pickle.type!]! };
        switch (rule.kind) {
          case "given": {
            const items = rule.read(args, pickle);
            s.given.push(...items.map((item) => ({ step: text, ...item }) as Given));
            const [first] = items;
            if (first && "op" in first) step.op = first.op;
            if (items.some((i) => "fault" in i)) step.fault = true;
            break;
          }
          case "then": {
            const { expect } = rule.read(args, pickle);
            s.expect.push({ step: text, ...expect } as Expectation);
            if ("op" in expect && expect.op !== undefined) step.op = expect.op;
            if ("called" in expect && expect.called !== undefined) step.called = expect.called;
            if ("decision" in expect) step.decision = expect.decision;
            break;
          }
          case "any":
            s.decisions.push({ step: text, ...rule.read(args, pickle) });
            break;
          case "when": {
            if (s.workflow !== undefined) throw new Error("a second When: a scenario runs its workflow once");
            const item = rule.read(args, pickle);
            if ("call" in item) {
              throw new Error(
                `"${text}" calls ${item.call} directly: a step for an operation's own test, in its connector's features`,
              );
            }
            Object.assign(s, item);
          }
        }
        s.steps.push(step);
      },
    };

    /** A record of an operation's own test, as a run's ledger would hold it. */
    function record(body: Record<string, unknown>): LedgerRecord {
      const n = records.length;
      return {
        v: 1,
        app: "test",
        id: `${pickleId}:${body.type as string}:${n}`,
        runId: pickleId,
        seq: n,
        at: Date.now(),
        actor: { id: "test" },
        workflow: "",
        ...body,
      } as LedgerRecord;
    }
  };
}

/**
 * The value with each string `$name` or `$name.field.field` replaced by what `values` holds
 * under that name (an output a `Given` named with `as`), at any depth.
 */
function resolve(value: unknown, values: ReadonlyMap<string, unknown>): unknown {
  if (typeof value === "string") {
    const ref = /^\$([A-Za-z_][\w-]*)((?:\.[\w-]+)*)$/.exec(value);
    if (!ref) return value;
    const [, name, path] = ref as unknown as [string, string, string];
    if (!values.has(name)) {
      const named = values.size ? `; the steps named ${[...values.keys()].join(", ")}` : "";
      throw new Error(`no value named "${name}" for ${value}${named}`);
    }
    return path
      .split(".")
      .slice(1)
      .reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], values.get(name));
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, values));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, values)]));
  }
  return value;
}

/**
 * Why a step that did not pass did not, at `file:line`: the error it failed with, no step
 * matching it (with the steps there are), or more than one; undefined for a step that passed or
 * did not run.
 */
function stepError(built: Built, report: Report, step: PickleStep, where: string): string | undefined {
  const result = report.steps.get(step.id);
  if (!result) return undefined;
  switch (result.status) {
    case StepStatus.PASSED:
    case StepStatus.SKIPPED:
      return undefined;
    case StepStatus.UNDEFINED:
      return step.type && KINDS[step.type]
        ? `${where}: no step matches "${step.text}"\n${built.known}`
        : `${where}: "${step.text}" needs a Given, When or Then before it`;
    case StepStatus.AMBIGUOUS: {
      const which = result.matches.flatMap((i) => built.byExpression[i]!.map((r) => `"${r.source}"`));
      return `${where}: "${step.text}" is ambiguous: it matches ${[...new Set(which)].join(" and ")}`;
    }
    default:
      return `${where}: ${result.message ?? `the step ended ${result.status}`}`;
  }
}

/** What `loadScenarios` returns. */
export interface LoadedScenarios {
  scenarios: Scenario[];
  errors: { file: string; message: string }[];
}

/**
 * Compiles the feature files `files` (relative to `dir`) into scenarios: Cucumber runs each,
 * and its steps record what they say. A file with an error has none of its scenarios: the
 * first error in it (a step that fails or matches no step or two, a scenario with no `When`,
 * a name used twice, a file Gherkin cannot parse, no scenarios at all) is its error.
 */
async function compile(scope: Scope, dir: string, files: string[]): Promise<LoadedScenarios> {
  const built = builtFor(scope);
  const errors = new Map<string, string>();
  let report: Report | undefined;
  const specs = new Map<string, Spec>();
  let left = files;
  // A file Gherkin cannot parse stops the whole run: it is left out, and the rest run again.
  while (left.length) {
    report = await runFeatures(built.library, worldFor(built, { kind: "compile", specs }), {
      cwd: dir,
      paths: left.map((f) => join(dir, f)),
      isBug,
    });
    if (report.parseErrors.length === 0) break;
    for (const { uri, line, message } of report.parseErrors) {
      if (!errors.has(uri)) errors.set(uri, `${uri}${line === undefined ? "" : `:${line}`}: ${message}`);
    }
    left = left.filter((f) => !errors.has(f));
    report = undefined;
  }
  const names = report ? namesOf(report) : new Map<string, string>();
  const scenarios: Scenario[] = [];
  for (const file of files) {
    if (errors.has(file) || !report) continue;
    const { text = "", document } = report.sources.get(file) ?? {};
    const pickles = report.pickles.filter((p) => p.uri === file);
    if (!document || pickles.length === 0) {
      errors.set(file, `${file}: no scenarios; add one with "Scenario: <name>"`);
      continue;
    }
    const lines = linesOf(document);
    const texts = textsOf(document, text);
    const inFile: Scenario[] = [];
    try {
      for (const pickle of pickles) {
        const line = lineOf(pickle, lines);
        const where = (at = lines.get(pickle.astNodeIds[0]!) ?? line) => `${file}:${at}`;
        for (const step of pickle.steps) {
          const error = stepError(built, report, step, where(lines.get(step.astNodeIds[0]!)));
          if (error) throw new Error(error);
        }
        const spec = specs.get(pickle.id)!;
        const { name, workflow } = spec;
        if (inFile.some((s) => s.name === name)) {
          throw new Error(`${where()}: a second scenario named "${name}"; give each its own name`);
        }
        if (workflow === undefined) {
          throw new Error(
            `${where()}: scenario "${name}" has no When: say which workflow runs, such as "When <workflow> runs with"`,
          );
        }
        const drift = spec.expect.find((e) => "declared" in e);
        if (drift && workflow !== DRIFT_WORKFLOW) {
          throw new Error(
            `${where()}: "${drift.step}" reads a drift report, so the scenario must run ${DRIFT_WORKFLOW}, not ${workflow}`,
          );
        }
        inFile.push({
          name: names.get(pickle.id) ?? name,
          file,
          line,
          workflow,
          text: texts.get(pickle.astNodeIds[0]!) ?? "",
          steps: spec.steps,
          given: spec.given,
          input: spec.input,
          decisions: spec.decisions,
          approvals: approvalsOf(scope.workflows.get(workflow)!),
          expect: spec.expect,
        });
      }
    } catch (err) {
      if (isBug(err)) throw err;
      errors.set(file, errorMessage(err));
      continue;
    }
    scenarios.push(...inFile);
  }
  // Each file's error, in the files' order, and the scenarios of the rest, one name each across files.
  const loaded: LoadedScenarios = { scenarios: [], errors: [] };
  const seen = new Map<string, string>();
  for (const file of files) {
    const error = errors.get(file);
    if (error !== undefined) {
      loaded.errors.push({ file, message: error });
      continue;
    }
    for (const s of scenarios.filter((x) => x.file === file)) {
      const other = seen.get(s.name);
      if (other !== undefined) {
        loaded.errors.push({
          file,
          message: `${file}: scenario "${s.name}" is also in ${other}; give each its own name`,
        });
        continue;
      }
      seen.set(s.name, file);
      loaded.scenarios.push(s);
    }
  }
  return loaded;
}

/**
 * Each scope's scenarios as last read, with the stamp of the files they were read from. By
 * scope, since what a file means depends on its operations and workflows.
 */
const loadedByScope = new WeakMap<Scope, { stamp: string; loaded: Promise<LoadedScenarios> }>();

/**
 * Every scenario in the `.feature` files under `scenarios` (a `file:` URL to a directory),
 * compiled by Cucumber, with an error for each file that does not compile and each name used
 * twice. No directory, or none given, is no scenarios. Rejects when an operation's phrase names
 * a field it lacks. The files are compiled again only once one is added, removed or written
 * (its name, `mtimeMs` or size changes): until then each call returns the same object, which
 * callers must not change.
 */
export async function loadScenarios(scope: Scope): Promise<LoadedScenarios> {
  if (!scope.scenarios) return { scenarios: [], errors: [] };
  const dir = fileURLToPath(scope.scenarios);
  if (!existsSync(dir)) return { scenarios: [], errors: [] };
  builtFor(scope);
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".feature"))
    .map((f) => f.replaceAll("\\", "/"))
    .toSorted();
  const stamp = JSON.stringify([
    dir,
    files.map((file) => {
      const { mtimeMs, size } = statSync(join(dir, file));
      return [file, mtimeMs, size];
    }),
  ]);
  const cached = loadedByScope.get(scope);
  if (cached?.stamp === stamp) return cached.loaded;
  const loaded = files.length ? compile(scope, dir, files) : Promise.resolve({ scenarios: [], errors: [] });
  loadedByScope.set(scope, { stamp, loaded });
  // A compile that throws (a bug) is not kept: the next call tries again.
  loaded.catch(() => {
    if (loadedByScope.get(scope)?.loaded === loaded) loadedByScope.delete(scope);
  });
  return loaded;
}

/** True when `actual` has every key `expected` has, with an equal value, at every depth. */
function contains(actual: unknown, expected: unknown): boolean {
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
    return isDeepStrictEqual(actual, expected);
  }
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([k, v]) => contains((actual as Record<string, unknown>)[k], v));
}

type Request = Extract<LedgerRecord, { type: "approval.requested" }>;
const isCall = (r: LedgerRecord): r is CallRecord => r.type === "op.called";
const isRequest = (r: LedgerRecord): r is Request => r.type === "approval.requested";

/** The inputs of the calls, as JSON, for a detail. */
const inputs = (list: CallRecord[]) => list.map((r) => JSON.stringify(r.input)).join(", ");

/** A policy's decision as words: `allowed`, `denied`, `held for finance`. */
const words = (d: RecordedDecision) =>
  d.kind === "allow" ? "allowed" : d.kind === "deny" ? "denied" : `held for ${approverLabel(d.approver)}`;

/** What the policy decided for the calls, each decision once: `allowed and held for finance`. */
const decisions = (calls: CallRecord[]) => [...new Set(calls.map((r) => words(r.decision)))].join(" and ");

/** True when `who` names the approver: a person by id, or a group by its name. */
const isApprover = (approver: Approver, who: string) =>
  typeof approver === "string" ? approver === who : approver.group === who;

/** How a drift report found a resource, as words: `clean`, `gone`, `drifted in has_wiki, topics`. */
const found = (r: DriftResult) =>
  r.status === "drifted" ? `drifted in ${r.fields.map((f) => f.path).join(", ")}` : r.status;

/**
 * Why a drift expectation fails against the report a finished drift run returned as its
 * output, or undefined when the report found the resource as expected.
 */
function driftDetail(
  e: Extract<CoreExpectation, { declared: string }>,
  end: Extract<LedgerRecord, { type: "run.finished" }>,
): string | undefined {
  const report = end.output as Partial<DriftReport> | null | undefined;
  if (!Array.isArray(report?.resources)) return "the run's output is not a drift report";
  const resource = report.resources.find((r) => r.id === e.declared);
  if (!resource) {
    return `no resource ${e.declared} in the report; it has ${report.resources.map((r) => r.id).join(", ") || "none"}`;
  }
  if (resource.status === "error") return `${e.declared} could not be read: ${resource.error}`;
  const ok =
    resource.status === e.status && (e.status !== "drifted" || resource.fields.some((f) => f.path === e.field));
  if (ok) return undefined;
  return `${e.declared} is ${found(resource)}, not ${e.status === "drifted" ? `drifted in ${e.field}` : e.status}`;
}

/** An expectation of the generic steps: one `detailOf` can check without the step's own code. */
export type CoreExpectation = Unstepped<Exclude<Expectation, { owner: string }>>;

/**
 * Why an expectation of the generic steps does not hold against a run's ledger records, or
 * undefined when it does: what the `Then` steps that state it check. Pure. A call is an
 * `op.called` record without an `error`; one with an error (a policy denial, a rejected
 * approval, a vendor's final failure) was attempted, not made. An operation `was denied` when
 * the policy's decision on some call to it is `deny`, and `was held for` an approver when an
 * approval for that approver holds it: one the policy asked for on its call, or one that
 * `covers` it. A drift expectation reads the report a finished drift run returned.
 */
export function detailOf(e: CoreExpectation, records: readonly LedgerRecord[]): string | undefined {
  const end = records.find((r) => r.type === "run.finished" || r.type === "run.failed");
  const calls = records.filter(isCall);
  const callsTo = (op: string) => calls.filter((r) => r.op === op);
  if ("decision" in e) {
    const tries = callsTo(e.op);
    if (e.decision === "denied") {
      if (tries.some((r) => r.decision.kind === "deny")) return undefined;
      return tries.length ? `${e.op} was ${decisions(tries)}, not denied` : `no call to ${e.op}`;
    }
    const holds = records.filter(isRequest).filter((r) => r.op === e.op || r.covers.includes(e.op));
    if (holds.some((r) => isApprover(r.approver, e.approver))) return undefined;
    return holds.length
      ? `${e.op} was held for ${[...new Set(holds.map((r) => approverLabel(r.approver)))].join(" and ")}, not ${e.approver}`
      : tries.length
        ? `${e.op} was ${decisions(tries)}, not held`
        : `no call to ${e.op}`;
  }
  if ("called" in e) {
    const tries = callsTo(e.op);
    const made = tries.filter((r) => !r.error);
    const matching = made.filter((r) => e.input === undefined || contains(r.input, e.input));
    if (matching.length > 0 === e.called) return undefined;
    if (!e.called) return `${e.op} was called with ${inputs(matching)}`;
    const what = e.input === undefined ? e.op : `${e.op} with ${JSON.stringify(e.input)}`;
    const tried = tries.flatMap(({ error }) => (error ? [`${error.code ?? error.name}: ${error.message}`] : []));
    return [
      `no call to ${what}`,
      ...(made.length ? [`its calls had ${inputs(made)}`] : []),
      ...(tried.length ? [`attempted: ${tried.join(", ")}`] : []),
    ].join("; ");
  }
  // The rest read how the run ended.
  if (!end) return "run not ended";
  if ("outcome" in e && e.outcome === "failed") {
    if (end.type !== "run.failed") return "the run finished";
    if (e.code === undefined || end.error.code === e.code) return undefined;
    return `the run failed with ${end.error.code ?? "no code"}: ${end.error.message}`;
  }
  // A finished run: what `the run succeeds` expects, and what a drift expectation reads its report from.
  if (end.type === "run.failed") return `the run failed: ${end.error.message}`;
  return "declared" in e ? driftDetail(e, end) : undefined;
}

/** What a `Then` step Cucumber skipped says: a step before it failed. */
export const NOT_CHECKED = "not checked (an earlier step failed)";

/**
 * Checks a run's ledger records against the scenario, as its feature file reads now: Cucumber
 * runs the scenario's `Then` steps as assertions, in order, and the rest of its steps do
 * nothing. One check per expectation (`scenario.expect`), in order: a step that failed has why
 * as its `detail`, and the steps after it in the scenario did not run, so each has
 * `NOT_CHECKED`. Rejects when the scenario no longer compiles as it did (a step the file no
 * longer matches, say): load the scenarios again first, as the app does.
 */
export async function check(scope: Scope, scenario: Scenario, records: readonly LedgerRecord[]): Promise<Check[]> {
  if (!scope.scenarios) throw new Error(`No scenarios directory to check scenario "${scenario.name}" from`);
  const built = builtFor(scope);
  const dir = fileURLToPath(scope.scenarios);
  const report = await runFeatures(built.library, worldFor(built, { kind: "check", view: viewOf(records) }), {
    cwd: dir,
    paths: [`${join(dir, scenario.file)}:${scenario.line}`],
    isBug,
  });
  const where = `${scenario.file}:${scenario.line}`;
  if (report.parseErrors.length) {
    throw new Error(`${where}: ${report.parseErrors.map((e) => e.message).join("; ")}`);
  }
  const names = namesOf(report);
  const pickle = report.pickles.find((p) => p.uri === scenario.file && names.get(p.id) === scenario.name);
  if (!pickle) throw new Error(`${where}: no scenario "${scenario.name}" there now`);
  const lines = linesOf(report.sources.get(scenario.file)!.document!);
  const checks: Check[] = [];
  let next = 0;
  for (const step of pickle.steps) {
    const at = `${scenario.file}:${lines.get(step.astNodeIds[0]!)}`;
    const expectation = scenario.expect[next];
    const result = report.steps.get(step.id);
    // Only a `Then` step expects: a `Given` can read the same as one (`{op} was called with`).
    if (expectation?.step !== step.text || KINDS[step.type!] !== "then") {
      const error = stepError(built, report, step, at);
      if (error) throw new Error(error);
      continue;
    }
    next++;
    if (result?.status === StepStatus.PASSED) checks.push(verdict(step.text));
    else if (result?.status === StepStatus.FAILED) checks.push(verdict(step.text, result.message ?? "did not hold"));
    else if (result?.status === StepStatus.SKIPPED) checks.push(verdict(step.text, NOT_CHECKED));
    else throw new Error(stepError(built, report, step, at) ?? `${at}: "${step.text}" did not run`);
  }
  if (next !== scenario.expect.length) {
    throw new Error(`${where}: scenario "${scenario.name}" no longer has the expectations it was read with`);
  }
  return checks;
}

/** A scenario of a feature file, as Gherkin reads it: where it is, its name and its tags. */
export interface FeatureScenario {
  /** The feature file, relative to the directory. */
  file: string;
  line: number;
  name: string;
  tags: string[];
}

/**
 * The scenarios of the `.feature` files under `dir` (a `file:` URL to a directory), in order,
 * named as `loadScenarios` names them, without running anything: what a test runner lists
 * before it runs each (`testFeature`). Throws, naming the file, for one Gherkin cannot parse.
 */
export function featureScenarios(dir: URL): FeatureScenario[] {
  const root = fileURLToPath(dir);
  const files = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".feature"))
    .map((f) => f.replaceAll("\\", "/"))
    .toSorted();
  const report: Report = { sources: new Map(), pickles: [], steps: new Map(), parseErrors: [] };
  const newId = IdGenerator.incrementing();
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    let document: GherkinDocument;
    try {
      document = new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher()).parse(text);
    } catch (err) {
      throw new Error(`${file}: ${errorMessage(err)}`, { cause: err });
    }
    report.sources.set(file, { text, document });
    report.pickles.push(...compilePickles(document, file, newId));
  }
  const names = namesOf(report);
  return report.pickles.map((pickle) => ({
    file: pickle.uri,
    line: lineOf(pickle, linesOf(report.sources.get(pickle.uri)!.document!)),
    name: names.get(pickle.id)!,
    tags: pickle.tags.map((t) => t.name),
  }));
}

/** Why one scenario of an operation's own test did not pass: its first step that did not, at `file:line`. */
export interface FeatureFailure {
  step: string;
  message: string;
}

/**
 * Runs the scenario at `line` of the feature file `file` (absolute) as an operation's own test:
 * its `Given` steps seed through the target, its `When` steps call the target's operations
 * directly (no worker, no policy), and its `Then` steps check those calls. Resolves to its first
 * failure, or undefined when every step passed.
 */
export async function testFeature(
  scope: Scope,
  file: string,
  line: number,
  target: FeatureTarget,
): Promise<FeatureFailure | undefined> {
  const built = builtFor(scope);
  const dir = join(file, "..");
  const report = await runFeatures(built.library, worldFor(built, { kind: "test", target }), {
    cwd: dir,
    paths: [`${file}:${line}`],
    isBug,
  });
  const [parseError] = report.parseErrors;
  if (parseError) {
    return { step: "did not load", message: `${parseError.uri}:${parseError.line ?? 1}: ${parseError.message}` };
  }
  for (const pickle of report.pickles) {
    const lines = linesOf(report.sources.get(pickle.uri)!.document!);
    for (const step of pickle.steps) {
      const error = stepError(built, report, step, `${pickle.uri}:${lines.get(step.astNodeIds[0]!)}`);
      if (error) return { step: step.text, message: error };
    }
  }
  return undefined;
}

/**
 * Decides the run's approvals as the scenario says until the run ends, and returns how it
 * ended. Each pending approval takes the decision naming its title (or id), else the next one
 * left that names no approval of the run (one it has asked for, or one its code names). Throws
 * for an approval with no such decision, and `run_running` when the run has not ended within
 * `timeoutMs` or the worker has not read a decision by then.
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
    const names = new Set([...scenario.approvals, ...run.approvals.flatMap((a) => [a.title, a.id])]);
    for (const approval of run.approvals.filter((a) => a.status === "pending")) {
      const named = left.findIndex((d) => d.approval === approval.title || d.approval === approval.id);
      const next = named === -1 ? left.findIndex((d) => !names.has(d.approval)) : named;
      if (next === -1) {
        const which = left.length
          ? `; the decisions left are for ${left.map((d) => `"${d.approval}"`).join(", ")}`
          : "";
        throw new Error(`Scenario "${scenario.name}" has no decision for "${approval.title}" (${approval.id})${which}`);
      }
      const [d] = left.splice(next, 1) as [Decision];
      const note = d.note === undefined ? {} : { note: d.note };
      const timeoutSeconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
      const decided = await client.decide(runId, { decision: d.decision, by: { id: d.by }, ...note }, approval.id, {
        timeoutSeconds,
      });
      if (decided.status === "pending") {
        throw new SanomaError(
          "run_running",
          `The worker did not read the decision for "${approval.title}" (${approval.id}) of run ${runId} within ${timeoutMs} ms`,
          { runId, approvalId: approval.id, timeoutMs },
        );
      }
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
