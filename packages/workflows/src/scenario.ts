import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
import {
  type GherkinDocument,
  IdGenerator,
  type PickleStep,
  PickleStepType,
  type Step as GherkinStep,
} from "@cucumber/messages";
import { z } from "zod";
import type { RunSummary, SanomaClient } from "./client.ts";
import type { ResolvedConfig } from "./config.ts";
import { SanomaError } from "./errors.ts";
import { fill, seedFrom } from "./fill.ts";
import type { LedgerRecord } from "./ledger.ts";
import { type OutlineNode, outlineWorkflow } from "./outline.ts";
import { errorMessage, isEnded } from "./shared.ts";

/*
 * Scenarios, at `@sanoma/workflows/scenario`: Gherkin feature files that say what a sandbox run
 * starts from (seeded fake vendors, injected faults), how its approvals are decided, and what it
 * should do. Server-side only, and kept off the main entry so a live worker never loads the
 * Gherkin parser or faker; the worker imports it (through `sandbox.ts`) only for a sandbox run.
 */

/** One step of a scenario, as written, for a list and for marking the graph node it is about. */
export interface ScenarioStep {
  text: string;
  kind: "given" | "when" | "then";
  /** The operation the step is about, when it names one. */
  op?: string;
  /** For a `Then` step about an operation: true when it expects a call, false for `was not called`. */
  called?: boolean;
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

/** What steps can name, the config's operations and workflows by id and name, and where the feature files are. */
export type Scope = Pick<ResolvedConfig, "ops" | "workflows" | "scenarios">;

type Kind = ScenarioStep["kind"];
type Unstepped<T> = T extends unknown ? Omit<T, "step"> : never;

/** What a step of each kind reads into; `any` is a decision, which a step of any keyword may make. */
interface Items {
  given: Unstepped<Given>;
  when: { workflow: string; input: unknown };
  then: Unstepped<Expectation>;
  any: Unstepped<Decision>;
}

type Rule = {
  [K in keyof Items]: {
    kind: K;
    /** The Cucumber expression, as listed in errors. */
    source: string;
    /** What else the step takes, as listed in errors. */
    takes?: string;
    /** For an operation's phrase: its id, which errors list it under. */
    phrase?: string;
    expression: CucumberExpression;
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

/** A mistake in this code, not in a feature file: thrown as it is, never filed as the file's error. */
const isBug = (err: unknown) => err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError;

/** The schema of the field `name` of an object schema; throws naming the fields it has. */
function fieldOf(schema: z.ZodType, name: string, owner: string): z.ZodType {
  const shape: Record<string, z.ZodType> = schema instanceof z.ZodObject ? schema.shape : {};
  if (!Object.hasOwn(shape, name)) {
    throw new Error(`no field "${name}" in ${owner}'s input; it has ${Object.keys(shape).join(", ") || "none"}`);
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
 * The fields the step's doc string (a JSON object) or two-column table gives an input, each
 * checked against its field in `schema`: a field the input lacks, or a value it refuses, is an error.
 */
function fieldsFrom(pickle: PickleStep, schema: z.ZodType, owner: string): Record<string, unknown> {
  const { docString, dataTable } = pickle.argument ?? {};
  const what = (name: string) => `${name} in ${owner}'s input`;
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

/** A parameter's transform: the name, when `ids` has it. */
const known = (what: string, ids: Map<string, unknown>) => (name: string) => {
  if (!ids.has(name)) throw new Error(`no ${what} "${name}"; the config has ${[...ids.keys()].toSorted().join(", ")}`);
  return name;
};

const TAKES_OBJECT = "a JSON doc string or a two-column table";

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
  const expression = (source: string) => new CucumberExpression(source, registry);
  const opOf = (id: unknown) => scope.ops.get(id as string)!;
  const workflowOf = (name: unknown) => scope.workflows.get(name as string)!;

  const rules: Rule[] = [
    {
      kind: "given",
      source: "{op} was called with",
      takes: TAKES_OBJECT,
      expression: expression("{op} was called with"),
      read: ([op], pickle) => ({
        op: op as string,
        input: fill(opOf(op).input, fieldsFrom(pickle, opOf(op).input, op as string)),
      }),
    },
    ...Object.entries(FAULTS).map(([words, fault]): Rule => ({
      kind: "given",
      source: `{op} ${words}`,
      expression: expression(`{op} ${words}`),
      read: ([op]) => ({ op: op as string, fault }),
    })),
    {
      kind: "when",
      source: "{workflow} runs with",
      takes: TAKES_OBJECT,
      expression: expression("{workflow} runs with"),
      read: ([name], pickle) => {
        const { input } = workflowOf(name);
        return { workflow: name as string, input: fill(input, fieldsFrom(pickle, input, name as string)) };
      },
    },
    {
      kind: "when",
      source: "{workflow} runs",
      expression: expression("{workflow} runs"),
      read: ([name]) => ({ workflow: name as string, input: fill(workflowOf(name).input, {}) }),
    },
    ...(["approve", "reject"] as const).flatMap((decision) => {
      const verb = decision === "approve" ? "approved" : "rejected";
      return [`{string} is ${verb} by {who}`, `{string} is ${verb} by {who} with note {string}`].map(
        (source): Rule => ({
          kind: "any",
          source,
          expression: expression(source),
          read: ([approval, by, note]) => ({
            approval: approval as string,
            decision,
            by: by as string,
            ...(note === undefined ? {} : { note: note as string }),
          }),
        }),
      );
    }),
    {
      kind: "then",
      source: "{op} was called with",
      takes: TAKES_OBJECT,
      expression: expression("{op} was called with"),
      read: ([op], pickle) => ({
        op: op as string,
        input: fieldsFrom(pickle, opOf(op).input, op as string),
        called: true,
      }),
    },
    ...[true, false].map((called): Rule => ({
      kind: "then",
      source: `{op} was ${called ? "" : "not "}called`,
      expression: expression(`{op} was ${called ? "" : "not "}called`),
      read: ([op]) => ({ op: op as string, called }),
    })),
    {
      kind: "then",
      source: "the run succeeds",
      expression: expression("the run succeeds"),
      read: () => ({ outcome: "finished" }),
    },
    {
      kind: "then",
      source: "the run fails",
      expression: expression("the run fails"),
      read: () => ({ outcome: "failed" }),
    },
    {
      kind: "then",
      source: "the run fails with {string}",
      expression: expression("the run fails with {string}"),
      read: ([code]) => ({ outcome: "failed", code: code as string }),
    },
  ];

  // Each operation's phrases, last. A field `{title}` becomes the parameter type `{field_title}`,
  // so a field named like another type (`op`, `string`, `int`) never takes that type's pattern.
  // It matches what `{string}` does, or one word, and unquotes the same way.
  const string = registry.lookupByTypeName("string")!;
  const word = /([^\s"']\S*)/;
  const field = (groups: string[]) => groups.at(-1) ?? string.transform(null, groups.slice(0, -1));
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
          return fieldOf(op.input, name, op.id);
        } catch {
          throw new Error(
            `${op.id}: its ${key} phrase "${template}" names {${name}}, which is not a field of its input`,
          );
        }
      });
      for (const name of fields) {
        if (registry.lookupByTypeName(`field_${name}`)) continue;
        registry.defineParameterType(
          new ParameterType(`field_${name}`, [...string.regexpStrings, word], null, (...g) => field(g), false),
        );
      }
      const given = (values: unknown[]) =>
        Object.fromEntries(
          fields.map((name, i) => [name, valueFor(schemas[i]!, values[i] as string, `${name} in ${op.id}'s input`)]),
        );
      const compiled = template.replaceAll(/\{([^}]*)\}/g, "{field_$1}");
      const common = { source: template, phrase: op.id, expression: expression(compiled) };
      rules.push(
        kind === "given"
          ? { ...common, kind, read: (values) => ({ op: op.id, input: fill(op.input, given(values)) }) }
          : { ...common, kind, read: (values) => ({ op: op.id, input: given(values), called: true }) },
      );
    }
  }
  rulesByScope.set(scope, rules);
  return rules;
}

/** Every step the scope knows, for an error: the generic ones by keyword, then each operation's phrases under its id. */
function knownSteps(rules: Rule[]): string {
  const keyword = (kind: Rule["kind"]) => (kind === "any" ? "Given/When/Then" : kind[0]!.toUpperCase() + kind.slice(1));
  const line = (r: Rule) => `${keyword(r.kind)} ${r.source}${r.takes ? ` (and ${r.takes})` : ""}`;
  const { generic = [], ...phrases } = Object.groupBy(rules, (r) => r.phrase ?? "generic");
  return [
    "Known steps:",
    ...generic.map((r) => `  ${line(r)}`),
    ...Object.entries(phrases).flatMap(([op, list]) => [`  ${op}:`, ...(list ?? []).map((r) => `    ${line(r)}`)]),
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

/**
 * The scenarios in a feature file: one per Gherkin pickle (each row of a `Scenario Outline`'s
 * examples is one; rows whose names would be the same get their line appended, such as
 * `Launch (line 12)`). Throws, naming `file:line`, for a file with no scenarios, a step no rule
 * or more than one matches, an unknown operation or workflow, a missing or second `When`, bad
 * JSON, or two scenarios with one name.
 */
export function parseFeature(text: string, file: string, scope: Scope): Scenario[] {
  const rules = rulesOf(scope);
  const newId = IdGenerator.incrementing();
  let doc: GherkinDocument;
  try {
    doc = new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher()).parse(text);
  } catch (err) {
    if (isBug(err)) throw err;
    throw new Error(`${file}: ${errorMessage(err)}`, { cause: err });
  }
  const lines = linesOf(doc);
  const texts = textsOf(doc, text);
  const pickles = compile(doc, file, newId);
  if (pickles.length === 0) throw new Error(`${file}: no scenarios; add one with "Scenario: <name>"`);
  // An outline's rows are named from its title; rows that share a name are told apart by their line.
  const counts = Map.groupBy(pickles, (p) => p.name);
  const scenarios: Scenario[] = [];
  for (const pickle of pickles) {
    const where = (line?: number) => `${file}:${line ?? pickle.location?.line ?? 1}`;
    const row = pickle.astNodeIds[1];
    const name =
      row !== undefined && counts.get(pickle.name)!.length > 1
        ? `${pickle.name} (line ${lines.get(row)})`
        : pickle.name;
    if (scenarios.some((s) => s.name === name)) {
      throw new Error(`${where()}: a second scenario named "${name}"; give each its own name`);
    }
    const scenario: Omit<Scenario, "workflow" | "approvals"> & { workflow?: string } = {
      name,
      file,
      text: texts.get(pickle.astNodeIds[0]!) ?? "",
      steps: [],
      given: [],
      input: undefined,
      decisions: [],
      expect: [],
    };
    // One name always makes up the same values.
    seedFrom(name);
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
      let op: string | undefined;
      let called: boolean | undefined;
      try {
        const values = args.map((a) => a.getValue<unknown>(null));
        const step = ps.text;
        switch (rule.kind) {
          case "given": {
            const item = rule.read(values, ps);
            scenario.given.push({ step, ...item });
            op = item.op;
            break;
          }
          case "then": {
            const item = rule.read(values, ps);
            scenario.expect.push({ step, ...item });
            if ("op" in item) ({ op, called } = item);
            break;
          }
          case "any":
            scenario.decisions.push({ step, ...rule.read(values, ps) });
            break;
          case "when": {
            if (scenario.workflow !== undefined) throw new Error("a second When: a scenario runs its workflow once");
            Object.assign(scenario, rule.read(values, ps));
          }
        }
      } catch (err) {
        if (isBug(err)) throw err;
        throw new Error(`${where(line)}: ${errorMessage(err)}`, { cause: err });
      }
      scenario.steps.push({
        text: ps.text,
        kind,
        ...(op === undefined ? {} : { op }),
        ...(called === undefined ? {} : { called }),
      });
    }
    const { workflow } = scenario;
    if (workflow === undefined) {
      throw new Error(
        `${where()}: scenario "${name}" has no When: say which workflow runs, such as "When <workflow> runs with"`,
      );
    }
    scenarios.push({ ...scenario, workflow, approvals: approvalsOf(scope.workflows.get(workflow)!) });
  }
  return scenarios;
}

/** What `loadScenarios` returns. */
export interface LoadedScenarios {
  scenarios: Scenario[];
  errors: { file: string; message: string }[];
}

/**
 * Each scope's scenarios as last read, with the stamp of the files they were read from. By
 * scope, since what a file means depends on its operations and workflows.
 */
const loadedByScope = new WeakMap<Scope, { stamp: string; loaded: LoadedScenarios }>();

/**
 * Every scenario in the `.feature` files under `scenarios` (a `file:` URL to a directory),
 * with an error for each file that does not parse and each name used twice. No directory,
 * or none given, is no scenarios. Throws when an operation's phrase names a field it lacks.
 * The files are parsed again only once one is added, removed or written (its name, `mtimeMs`
 * or size changes): until then each call returns the same object, which callers must not change.
 */
export function loadScenarios(scope: Scope): LoadedScenarios {
  if (!scope.scenarios) return { scenarios: [], errors: [] };
  const dir = fileURLToPath(scope.scenarios);
  if (!existsSync(dir)) return { scenarios: [], errors: [] };
  rulesOf(scope);
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
  const scenarios: Scenario[] = [];
  const errors: { file: string; message: string }[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    let parsed: Scenario[];
    try {
      parsed = parseFeature(readFileSync(join(dir, file), "utf8"), file, scope);
    } catch (err) {
      if (isBug(err)) throw err;
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
  const loaded = { scenarios, errors };
  loadedByScope.set(scope, { stamp, loaded });
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

type Call = Extract<LedgerRecord, { type: "op.called" }>;
const isCall = (r: LedgerRecord): r is Call => r.type === "op.called";

/**
 * Checks each of the scenario's expectations against a run's ledger records. Pure. A call is an
 * `op.called` record without an `error`; one with an error (a policy denial, a rejected
 * approval, a vendor's final failure) was attempted, not made.
 */
export function check(scenario: Scenario, records: readonly LedgerRecord[]): Check[] {
  const end = records.find((r) => r.type === "run.finished" || r.type === "run.failed");
  return scenario.expect.map((e): Check => {
    if ("op" in e) {
      const tries = records.filter(isCall).filter((r) => r.op === e.op);
      const calls = tries.filter((r) => !r.error);
      const matching = calls.filter((r) => e.input === undefined || contains(r.input, e.input));
      const ok = matching.length > 0 === e.called;
      if (ok) return { step: e.step, ok };
      const what = e.input === undefined ? e.op : `${e.op} with ${JSON.stringify(e.input)}`;
      const inputs = (list: Call[]) => list.map((r) => JSON.stringify(r.input)).join(", ");
      if (!e.called) return { step: e.step, ok, detail: `${e.op} was called with ${inputs(matching)}` };
      const tried = tries.flatMap(({ error }) => (error ? [`${error.code ?? error.name}: ${error.message}`] : []));
      return {
        step: e.step,
        ok,
        detail: [
          `no call to ${what}`,
          ...(calls.length ? [`its calls had ${inputs(calls)}`] : []),
          ...(tried.length ? [`attempted: ${tried.join(", ")}`] : []),
        ].join("; "),
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
