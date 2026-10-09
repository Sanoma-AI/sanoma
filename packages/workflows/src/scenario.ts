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
import { faker } from "@faker-js/faker";
import { fake, seed, setFaker } from "zod-schema-faker/v4";
import { z } from "zod";
import type { RunSummary, SanomaClient } from "./client.ts";
import type { ResolvedConfig } from "./config.ts";
import { SanomaError } from "./errors.ts";
import type { LedgerRecord } from "./ledger.ts";
import { errorMessage, isEnded } from "./shared.ts";

/*
 * Scenarios, at `@sanoma/workflows/scenario`: Gherkin feature files that say what a sandbox run
 * starts from (seeded fake vendors, injected faults), how its approvals are decided, and what it
 * should do. Server-side only, and kept off the main entry so a live worker never loads the
 * Gherkin parser or faker; the worker imports it (through `sandbox.ts`) only for a sandbox run.
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

const unquote = (s: string) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

/** A mistake in this code, not in a feature file: thrown as it is, never filed as the file's error. */
const isBug = (err: unknown) => err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError;

/** The schema's value with every field `given` does not set made up, parsed by the schema. */
function fill(schema: z.ZodType, given: Record<string, unknown>): unknown {
  return schema.parse({ ...(fake(schema) as object), ...given });
}

/** A JSON object from the step's doc string or its two-column table (values parsed as JSON when they parse). */
function object(pickle: PickleStep): Record<string, unknown> {
  const { docString, dataTable } = pickle.argument ?? {};
  let value: unknown;
  if (dataTable) {
    value = Object.fromEntries(
      dataTable.rows.map(({ cells }) => {
        if (cells.length !== 2) throw new Error(`the table after "${pickle.text}" needs two columns: name | value`);
        const [name, raw] = cells.map((c) => c.value) as [string, string];
        try {
          return [name, JSON.parse(raw)];
        } catch {
          return [name, raw];
        }
      }),
    );
  } else if (docString) {
    try {
      value = JSON.parse(docString.content);
    } catch (err) {
      throw new Error(`the doc string after "${pickle.text}" is not JSON: ${errorMessage(err)}`, { cause: err });
    }
  } else {
    throw new Error(`"${pickle.text}" needs a JSON doc string or a two-column table after it`);
  }
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
      read: ([op], pickle) => ({ op: op as string, input: fill(opOf(op).input, object(pickle)) }),
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
      read: ([name], pickle) => ({ workflow: name as string, input: fill(workflowOf(name).input, object(pickle)) }),
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
      read: ([op], pickle) => ({ op: op as string, input: object(pickle), called: true }),
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

  // Each operation's phrases, last: their fields become parameter types the generic steps never use.
  for (const op of scope.ops.values()) {
    const properties = (z.toJSONSchema(op.input, { unrepresentable: "any" }).properties ?? {}) as Record<
      string,
      { type?: unknown }
    >;
    // A phrase's key, and the keyword of the steps it adds.
    for (const [key, kind] of [
      ["given", "given"],
      ["expect", "then"],
    ] as const) {
      const template = op.phrases?.[key];
      if (template === undefined) continue;
      const fields = [...template.matchAll(/\{([^}]*)\}/g)].map(([, name]) => name!);
      for (const name of fields) {
        if (!Object.hasOwn(properties, name)) {
          throw new Error(
            `${op.id}: its ${key} phrase "${template}" names {${name}}, which is not a field of its input`,
          );
        }
        if (!registry.lookupByTypeName(name)) {
          registry.defineParameterType(new ParameterType(name, /"[^"]*"|\S+/, null, unquote, false));
        }
      }
      const given = (values: unknown[]) =>
        Object.fromEntries(fields.map((name, i) => [name, coerce(String(values[i]), properties[name]?.type)]));
      const common = { source: template, phrase: op.id, expression: expression(template) };
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

/** A number from the scenario's name, so one name always makes up the same values. */
const seedOf = (name: string) => createHash("sha256").update(name).digest().readUInt32BE(0);

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
    const scenario: Omit<Scenario, "workflow"> & { workflow?: string } = {
      name,
      file,
      text,
      steps: [],
      given: [],
      input: undefined,
      decisions: [],
      expect: [],
    };
    seed(seedOf(name));
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
            op = "op" in item ? item.op : undefined;
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
      scenario.steps.push({ text: ps.text, kind, ...(op === undefined ? {} : { op }) });
    }
    const { workflow } = scenario;
    if (workflow === undefined) {
      throw new Error(
        `${where()}: scenario "${name}" has no When: say which workflow runs, such as "When <workflow> runs with"`,
      );
    }
    scenarios.push({ ...scenario, workflow });
  }
  return scenarios;
}

/**
 * Every scenario in the `.feature` files under `scenarios` (a `file:` URL to a directory),
 * with an error for each file that does not parse and each name used twice. No directory,
 * or none given, is no scenarios. Throws when an operation's phrase names a field it lacks.
 */
export function loadScenarios(scope: Scope): {
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
