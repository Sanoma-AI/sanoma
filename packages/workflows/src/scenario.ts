import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ISupportCodeLibrary } from "@cucumber/cucumber/api";
import { ParameterTypeRegistry } from "@cucumber/cucumber-expressions";
import {
  type Pickle,
  type PickleStep,
  PickleStepType,
  type Scenario as GherkinScenario,
  type Step as GherkinStep,
} from "@cucumber/messages";
import type { z } from "zod";
import type { RunSummary, SanomaClient } from "./client.ts";
import type { Approver } from "./define.ts";
import type { ResolvedConfig } from "./config.ts";
import {
  buildLibrary,
  lineOf,
  type ParameterTypeSpec,
  type Report,
  runFeatures,
  type SanomaWorld,
  type StepResult,
  stepResults,
  StepStatus,
} from "./cucumber.ts";
import { errorCode, errorInfo, SanomaError } from "./errors.ts";
import { type CallRecord, contains, type CoreExpectation, detailOf, isCall } from "./expectations.ts";
import type { Fake } from "./fake.ts";
import { fill, isBug, objectUnder, restOf, seedFrom, shapeOf } from "./fill.ts";
import type { LedgerRecord } from "./ledger.ts";
import type { Driver, Op } from "./op.ts";
import { type OutlineNode, outlineWorkflow } from "./outline.ts";
import { isObject } from "./resource.ts";
import { admit, type DeclaredPeople, readPeople } from "./resources.ts";
import { memorySecrets } from "./secret.ts";
import {
  APPLY_WORKFLOW,
  BUILT_IN_WORKFLOWS,
  DATA_VENDOR,
  declaresPeople,
  DRIFT_WORKFLOW,
  errorMessage,
  fitsOp,
  flatten,
  groupNamesOf,
  isEnded,
  principalIdsOf,
  problemLine,
  RUNTIME_AGENTS,
} from "./shared.ts";
import type { Call, RunView, Seed } from "./steps.ts";

/*
 * Scenarios, at `@sanoma-ai/workflows/scenario`: Gherkin feature files that say what a sandbox run
 * starts from (seeded fake vendors, injected faults), how its approvals are decided, and what it
 * should do. Cucumber runs them (`cucumber.ts`), in two ways: compiling a feature file into
 * scenarios, where the steps only record what they say, and checking a run's ledger against one,
 * where only its `Then` steps run, each judged on its own. A connector's own feature files run a third
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
  /** For a `Then` step about a step by its name (`step "Draft the post" was called`): that name. */
  name?: string;
  /**
   * For a `Then` step about an operation, or a step by its name: true when it expects a call (or
   * a run), false for `was not called` (or `ran 0 times`).
   */
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
 * What the run should do: call an operation (with at least this input) or not, run the step
 * `name`d in the workflow's outline or not, or a number of `times`, have the policy deny an
 * operation (`denied`, for a `reason` when the step names one) or hold one for an approver
 * (`held`: a person's id or a group's name, or `{ group }` a group's alone), end a certain way,
 * for a drift run, report the resource `declared` (`<file>#<export>`) clean, gone, absent, or
 * drifted in a field, or for an apply run, create it, or leave it bound to an object (`bound`,
 * its vendor's id).
 * A step whose own code checks the run (a connector's or the company's, or an operation's own
 * test's) is `custom`, with what it is about.
 */
export type Expectation =
  | { step: string; op: string; input?: unknown; called: boolean }
  | { step: string; name: string; input?: unknown; called: boolean }
  | { step: string; name: string; times: number }
  | { step: string; op: string; decision: "denied"; reason?: string }
  | { step: string; op: string; decision: "held"; approver: Approver }
  | { step: string; outcome: "finished" | "failed"; code?: string }
  | { step: string; declared: string; status: "clean" | "gone" | "absent" }
  | { step: string; declared: string; status: "drifted"; field: string }
  | { step: string; declared: string; created: true }
  | { step: string; declared: string; bound: string }
  | { step: string; custom: true; op?: string; called?: boolean };

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
  /** Who starts the run, by id, when a `Given <who> is acting` says: a declared person or agent. */
  startedBy?: string;
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
 * What steps can name: the config's operations, workflows, resource types and collections by id,
 * the steps its connectors (and the company) ship, where the feature files are, and the root
 * whose data files declare its people.
 */
export type Scope = Pick<
  ResolvedConfig,
  "ops" | "workflows" | "scenarios" | "types" | "collections" | "steps" | "root"
>;

type Kind = ScenarioStep["kind"];
type Fault = Extract<Seed, { fault: unknown }>["fault"];
type Unstepped<T> = T extends unknown ? Omit<T, "step"> : never;

/** What a `When` says: which workflow runs, on what; or, in an operation's own test, a call to make. */
type When = { workflow: string; input: unknown } | { call: string; input: Record<string, unknown> };

/** What a `Then` says: its expectation, and how to check it against a run. */
interface Then {
  expect: Unstepped<Expectation>;
  verify(run: RunView): string | undefined;
}

/**
 * What a step of each kind reads into; `any` is a decision, which a step of any keyword may make,
 * and `actor` a `Given` saying who starts the run (`{who} is acting`), by id.
 */
interface Items {
  given: Unstepped<Given>[];
  actor: string;
  when: When;
  then: Then;
  any: Unstepped<Decision>;
}

type Rule = {
  [K in keyof Items]: {
    kind: K;
    /** The step as listed in errors: its Cucumber expression, or an operation's phrase as written. */
    source: string;
    /** The Cucumber expression it is registered with, when that is not its source. */
    expression?: string;
    /** What else the step takes, as listed in errors. */
    takes?: string;
    /** Whose step it is, which errors list it under: an operation's id for its phrase, or a step library's owner. */
    group?: string;
    /**
     * What the step says, from the expression's values and the step's doc string or table;
     * `workflow` is the scenario's, once its `When` has named it.
     */
    read(values: unknown[], pickle: PickleStep, workflow?: string): Items[K];
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

/**
 * The schema of the field `name` of an object schema (`owner`, for the error), or of the fields it
 * takes besides its own (`restOf`); throws naming the fields it has.
 */
function fieldOf(schema: z.ZodType, name: string, owner: string): z.ZodType {
  const shape = shapeOf(schema);
  if (Object.hasOwn(shape, name)) return shape[name]!;
  const rest = restOf(schema);
  if (rest) return rest;
  throw new Error(`no field "${name}" in ${owner}; it has ${Object.keys(shape).join(", ") || "none"}`);
}

const issues = (error: z.ZodError) => error.issues.map((i) => i.message).join("; ");

/**
 * Why `field` refuses `value`, or undefined when it takes it. `partial`, for what a `Then` expects
 * at least: an object may leave fields out at any depth, and only the fields it has are checked.
 */
function refusal(field: z.ZodType, value: unknown, what: string, partial: boolean): string | undefined {
  const object = partial && isObject(value) ? objectUnder(field) : undefined;
  if (object) return fieldsRefusal(object, value as Record<string, unknown>, what, true);
  const parsed = field.safeParse(value);
  return parsed.success ? undefined : `${what} cannot be ${JSON.stringify(value)}: ${issues(parsed.error)}`;
}

/** Why the object schema refuses the first of `fields` it refuses (`refusal`), `owner` its owner in errors. */
function fieldsRefusal(
  schema: z.ZodType,
  fields: Record<string, unknown>,
  owner: string,
  partial: boolean,
): string | undefined {
  for (const [name, v] of Object.entries(fields)) {
    const why = refusal(fieldOf(schema, name, owner), v, `${name} in ${owner}`, partial);
    if (why) return why;
  }
  return undefined;
}

/**
 * The value text from a table cell or a phrase gives a field: the text itself when the field
 * takes it, else the text read as JSON (a number, `true`, a list) when the field takes that.
 */
function valueFor(field: z.ZodType, text: string, what: string, partial = false): unknown {
  const asText = field.safeParse(text);
  if (asText.success) return text;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${what} cannot be ${JSON.stringify(text)}: ${issues(asText.error)}`);
  }
  const why = refusal(field, json, what, partial);
  if (why) throw new Error(why);
  return json;
}

/**
 * The fields the step's doc string (a JSON object) or two-column table gives `owner` (an
 * operation's input, or a resource), each checked against its field in `schema`: a field it
 * lacks, or a value it refuses, is an error. `partial` (a `Then`'s "at least these fields"):
 * an object value may leave fields out, at any depth.
 */
function fieldsFrom(pickle: PickleStep, schema: z.ZodType, owner: string, partial = false): Record<string, unknown> {
  const { docString, dataTable } = pickle.argument ?? {};
  const what = (name: string) => `${name} in ${owner}`;
  if (dataTable) {
    return Object.fromEntries(
      dataTable.rows.map(({ cells }) => {
        if (cells.length !== 2) throw new Error(`the table after "${pickle.text}" needs two columns: name | value`);
        const [name, text] = cells.map((c) => c.value) as [string, string];
        return [name, valueFor(fieldOf(schema, name, owner), text, what(name), partial)];
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
  if (!isObject(value)) throw new Error(`"${pickle.text}" needs a JSON object`);
  const why = fieldsRefusal(schema, value, owner, partial);
  if (why) throw new Error(why);
  return value;
}

/** A parameter's transform: the name, when `ids` has it. */
const known = (what: string, ids: ReadonlyMap<string, unknown>) => (name: string) => {
  if (!ids.has(name)) throw new Error(`no ${what} "${name}"; the config has ${[...ids.keys()].toSorted().join(", ")}`);
  return name;
};

const TAKES_OBJECT = "a JSON doc string or a two-column table";

/** What a field belongs to, in errors: an operation's or a workflow's input. */
const inputOf = (name: unknown) => `${name as string}'s input`;

/** A step's verdict: passed when there is no `detail`. */
const verdict = (step: string, detail?: string): Check =>
  detail === undefined ? { step, ok: true } : { step, ok: false, detail };

/** The rules and the parameter types for one scope, and the Cucumber library built from them. */
interface Built {
  scope: Scope;
  /** The rules by the expression they are registered with. */
  byExpression: Map<string, Rule[]>;
  library: ISupportCodeLibrary;
  /** Every step the scope knows, for an error. */
  known: string;
}

const expressionOf = (rule: Rule) => rule.expression ?? rule.source;

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
    cached.scope.collections === scope.collections &&
    cached.scope.steps === scope.steps &&
    cached.scope.root === scope.root
  ) {
    return cached;
  }
  const { rules, parameterTypes } = rulesOf(scope);
  const byExpression = Map.groupBy(rules, expressionOf);
  const library = buildLibrary(parameterTypes, byExpression.keys());
  const built: Built = { scope, byExpression, library, known: knownSteps(rules) };
  builtByOps.set(scope.ops, built);
  return built;
}

/** The built-in workflows, whose input is never made up: each field is optional, and left out unless given. */

/** A `Then` step of the generic steps: its expectation, checked against the run's records. */
const expecting = (expect: CoreExpectation): Then => ({ expect, verify: (run) => detailOf(expect, run.records) });

/** The rules a scope has, and the parameter types their expressions use. */
function rulesOf(scope: Scope): { rules: Rule[]; parameterTypes: ParameterTypeSpec[] } {
  const { types, collections } = scope;
  // A collection's records are seeded as a resource's objects are, by `data.<name>`, through its operations.
  const collectionOf = (id: unknown) =>
    (id as string).startsWith(`${DATA_VENDOR}.`)
      ? collections.get((id as string).slice(DATA_VENDOR.length + 1))
      : undefined;
  const seedable = new Map<string, unknown>([
    ...types,
    ...[...collections.keys()].map((n) => [`${DATA_VENDOR}.${n}`, n] as const),
  ]);
  const parameterTypes: ParameterTypeSpec[] = [
    { name: "op", regexp: /\S+/, transformer: known("operation", scope.ops) },
    { name: "workflow", regexp: /\S+/, transformer: known("workflow", scope.workflows) },
    { name: "who", regexp: /\S+/, transformer: (s) => s },
    { name: "resource", regexp: /\S+/, transformer: known("resource type", seedable) },
    // A declared resource, as a drift report names it: `<file>#<export>`.
    { name: "declared", regexp: /[^\s#]+#\S+/, transformer: (s) => s },
    { name: "field", regexp: /\S+/, transformer: (s) => s },
  ];
  const opOf = (id: unknown) => scope.ops.get(id as string)!;
  const workflowOf = (name: unknown) => scope.workflows.get(name as string)!;
  // The people as the root's data files declare them when a step names one (`readPeople`, read
  // again only once a file changed): while they declare no one, any id and any group go.
  /** `who`, as a run's start admits them (`admit`): a declared person or agent. */
  const actorNamed = (who: string) => {
    const declared = readPeople(scope.root);
    try {
      return admit({ id: who }, declared).id;
    } catch (err) {
      if (errorCode(err) !== "not_admitted" || declared.problems.length) throw err;
      const ids = [...principalIdsOf(declared.people), ...RUNTIME_AGENTS].join(", ");
      throw new Error(`${who} is not a declared person or agent; resources/ declares ${ids}`, { cause: err });
    }
  };
  /** `group`, a declared group or `agents`, while the people's files have no problems. */
  const groupNamed = (group: string) => {
    const { people, problems } = readPeople(scope.root);
    if (problems.length) {
      throw new Error(
        `no group can be told while the people's files have problems: ${problems.map(problemLine).join("; ")}`,
      );
    }
    const groups = groupNamesOf(people);
    if (!declaresPeople(people) || groups.includes(group)) return group;
    throw new Error(`no group "${group}"; resources/ declares ${groups.join(", ")}`);
  };
  /** A resource step's object: its type's id, vendor and type, and its import id. */
  const object = (id: unknown, name: unknown) => {
    const { vendor, type } = types.get(id as string)!;
    return { resource: id as string, vendor, type, name: name as string };
  };
  const rules: Rule[] = [
    { kind: "actor", source: "{who} is acting", read: ([who]) => actorNamed(who as string) },
    {
      kind: "given",
      source: "{op} was called with",
      takes: TAKES_OBJECT,
      read: ([op], pickle) => [
        { op: op as string, input: fill(opOf(op).input, fieldsFrom(pickle, opOf(op).input, inputOf(op))) },
      ],
    },
    ...Object.entries(FAULTS).map(([words, fault]): Rule => ({
      kind: "given",
      source: `{op} ${words}`,
      read: ([op]) => [{ op: op as string, fault }],
    })),
    {
      kind: "given",
      source: "{resource} {string} has",
      takes: TAKES_OBJECT,
      read: ([resource, name], pickle) => {
        const owner = `${resource as string} "${name as string}"`;
        const c = collectionOf(resource);
        if (c) {
          // The record with its key, the fields the step gives, and the rest made up.
          const record = shapeOf(opOf(c.save.id).input).record!;
          const fields = fieldsFrom(pickle, record, owner);
          if (Object.hasOwn(fields, c.key) && fields[c.key] !== name) {
            throw new Error(
              `${c.key} in ${owner} is ${JSON.stringify(fields[c.key])}: it is the key, "${name as string}"`,
            );
          }
          return [{ op: c.save.id, input: { record: fill(record, { ...fields, [c.key]: name }) } }];
        }
        return [
          { ...object(resource, name), fields: fieldsFrom(pickle, types.get(resource as string)!.schema, owner) },
        ];
      },
    },
    {
      kind: "given",
      source: "{resource} {string} is gone",
      read: ([resource, name]) => {
        const c = collectionOf(resource);
        return [c ? { op: c.delete.id, input: { key: name } } : { ...object(resource, name), gone: true }];
      },
    },
    {
      kind: "when",
      source: "{workflow} runs with",
      takes: TAKES_OBJECT,
      read: ([name], pickle) => {
        const { input } = workflowOf(name);
        const given = fieldsFrom(pickle, input, inputOf(name));
        return {
          workflow: name as string,
          input: BUILT_IN_WORKFLOWS.has(name as string) ? input.parse(given) : fill(input, given),
        };
      },
    },
    {
      kind: "when",
      source: "{workflow} runs",
      // A built-in's input is optional throughout: what is not given is left out, not made up.
      read: ([name]) => ({
        workflow: name as string,
        input: BUILT_IN_WORKFLOWS.has(name as string) ? {} : fill(workflowOf(name).input, {}),
      }),
    },
    // An operation's own test: a call made to its driver, or its fake, directly.
    {
      kind: "when",
      source: "{op} is called with",
      takes: TAKES_OBJECT,
      read: ([op], pickle) => ({
        call: op as string,
        input: fill(opOf(op).input, fieldsFrom(pickle, opOf(op).input, inputOf(op))) as Record<string, unknown>,
      }),
    },
    ...(["approve", "reject"] as const).flatMap((decision) => {
      const verb = decision === "approve" ? "approved" : "rejected";
      return [`{string} is ${verb} by {who}`, `{string} is ${verb} by {who} with note {string}`].map(
        (source): Rule => ({
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
    {
      kind: "then",
      source: "{op} was called with",
      takes: TAKES_OBJECT,
      read: ([op], pickle) =>
        expecting({ op: op as string, input: fieldsFrom(pickle, opOf(op).input, inputOf(op), true), called: true }),
    },
    ...[true, false].map((called): Rule => ({
      kind: "then",
      source: `{op} was ${called ? "" : "not "}called`,
      read: ([op]) => expecting({ op: op as string, called }),
    })),
    {
      kind: "then",
      source: "{op} was denied",
      read: ([op]) => expecting({ op: op as string, decision: "denied" }),
    },
    {
      kind: "then",
      source: "{op} was denied with {string}",
      read: ([op, reason]) => expecting({ op: op as string, decision: "denied", reason: reason as string }),
    },
    {
      kind: "then",
      source: "{op} was held for {who}",
      read: ([op, who]) => expecting({ op: op as string, decision: "held", approver: who as string }),
    },
    {
      kind: "then",
      source: "{op} was held for group {string}",
      read: ([op, group]) =>
        expecting({ op: op as string, decision: "held", approver: { group: groupNamed(group as string) } }),
    },
    {
      kind: "then",
      source: "step {string} was called with",
      takes: TAKES_OBJECT,
      read: ([name], pickle, workflow) => {
        const node = stepNamed(scope, workflow, name as string);
        const step = `step "${name as string}"`;
        if (node.kind !== "op") {
          throw new Error(`${step} is ${node.kind === "sleep" ? "a sleep" : "an approval"}, which takes no input`);
        }
        // An unnamed call with a computed segment is named by the operation it calls.
        const op = scope.ops.get(node.id) ?? (node.name === undefined ? scope.ops.get(name as string) : undefined);
        if (!op) throw new Error(`${step} calls ${node.id}, whose input cannot be read: name its operation in full`);
        return expecting({
          name: name as string,
          input: fieldsFrom(pickle, op.input, inputOf(op.id), true),
          called: true,
        });
      },
    },
    ...[true, false].map((called): Rule => ({
      kind: "then",
      source: `step {string} was ${called ? "" : "not "}called`,
      read: ([name], _, workflow) => {
        stepNamed(scope, workflow, name as string);
        return expecting({ name: name as string, called });
      },
    })),
    {
      kind: "then",
      source: "step {string} ran {int} time(s)",
      read: ([name, times], _, workflow) => {
        stepNamed(scope, workflow, name as string);
        return expecting({ name: name as string, times: times as number });
      },
    },
    {
      kind: "then",
      source: "{declared} is drifted in {field}",
      read: ([declared, field]) =>
        expecting({ declared: declared as string, status: "drifted", field: field as string }),
    },
    ...(["clean", "gone", "absent"] as const).map((status): Rule => ({
      kind: "then",
      source: `{declared} is ${status}`,
      read: ([declared]) => expecting({ declared: declared as string, status }),
    })),
    {
      kind: "then",
      source: "apply creates {declared}",
      read: ([declared]) => expecting({ declared: declared as string, created: true }),
    },
    {
      kind: "then",
      source: "{declared} is bound to {string}",
      read: ([declared, id]) => expecting({ declared: declared as string, bound: id as string }),
    },
    { kind: "then", source: "the run succeeds", read: () => expecting({ outcome: "finished" }) },
    { kind: "then", source: "the run fails", read: () => expecting({ outcome: "failed" }) },
    {
      kind: "then",
      source: "the run fails with {string}",
      read: ([code]) => expecting({ outcome: "failed", code: code as string }),
    },
    // The result of the last call: what an operation's own test checks.
    {
      kind: "then",
      source: "it returns",
      takes: "a JSON doc string or a two-column table, of fields of its output",
      read: (_, pickle) => ({
        expect: { custom: true },
        verify: ({ records }) => {
          const last = lastCall(records);
          if (typeof last === "string") return last;
          if (last.error) return `it failed: ${last.error.code ?? last.error.name}: ${last.error.message}`;
          const expected = fieldsFrom(pickle, opOf(last.op).output, `${last.op}'s output`, true);
          return contains(last.output, expected) ? undefined : `it returned ${JSON.stringify(last.output)}`;
        },
      }),
    },
    {
      kind: "then",
      source: "it fails with status {int}",
      read: ([status]) => ({
        expect: { custom: true },
        verify: ({ records }) => {
          const last = lastCall(records);
          if (typeof last === "string") return last;
          if (!last.error) return `it returned ${JSON.stringify(last.output)}`;
          if (last.error.status === status) return undefined;
          return `it failed with ${last.error.status === undefined ? "no status" : `status ${last.error.status}`}: ${last.error.message}`;
        },
      }),
    },
  ];

  // Each step library's steps, after the generic ones.
  /** An operation a step library's step names: one of the config's. */
  const opNamed = (op: Op) => known("operation", scope.ops)(op.id);
  for (const { owner, steps } of scope.steps) {
    for (const def of steps) {
      const base = { source: def.expression, group: owner };
      if (def.kind === "given") {
        rules.push({
          ...base,
          kind: "given",
          read: (values) => {
            const seed = def.fn(...values);
            const op = opNamed(seed.op);
            if ("fault" in seed) return [{ op, fault: seed.fault }];
            let input: unknown;
            try {
              input = fill(opOf(op).input, seed.input);
            } catch (err) {
              if (isBug(err)) throw err;
              throw new Error(`${inputOf(op)} cannot be ${JSON.stringify(seed.input)}: ${errorMessage(err)}`, {
                cause: err,
              });
            }
            return [{ op, input, ...(seed.as === undefined ? {} : { as: seed.as }) }];
          },
        });
        continue;
      }
      rules.push({
        ...base,
        kind: "then",
        read: (values) => {
          const expected = def.fn(...values);
          return {
            expect: {
              custom: true,
              ...(expected.op === undefined ? {} : { op: opNamed(expected.op) }),
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
      // An `expect` phrase, like `was called with`, may give some of an object's fields.
      const given = (values: unknown[]) =>
        Object.fromEntries(
          fields.map((name, i) => [
            name,
            valueFor(schemas[i]!, values[i] as string, `${name} in ${inputOf(op.id)}`, kind === "then"),
          ]),
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
  const keyword = (kind: Rule["kind"]) =>
    kind === "any" ? "Given/When/Then" : kind === "actor" ? "Given" : kind[0]!.toUpperCase() + kind.slice(1);
  const line = (r: Rule) => `${keyword(r.kind)} ${r.source}${r.takes ? ` (and ${r.takes})` : ""}`;
  const { generic = [], ...groups } = Object.groupBy(rules, (r) => r.group ?? "generic");
  return [
    "Known steps:",
    ...generic.map((r) => `  ${line(r)}`),
    ...Object.entries(groups).flatMap(([group, list]) => [`  ${group}:`, ...(list ?? []).map((r) => `    ${line(r)}`)]),
  ].join("\n");
}

/**
 * A scenario's own lines of its file's `text`: from its keyword line to the end of its last
 * step (the closing delimiter of a doc string, the last row of a table) or of its examples'
 * last row, each line less the keyword line's indent.
 */
function textOf(scenario: GherkinScenario, text: string): string {
  const lines = text.split(/\r?\n/);
  const endOf = (step: GherkinStep): number => {
    if (step.dataTable) return step.dataTable.rows.at(-1)?.location.line ?? step.location.line;
    if (!step.docString) return step.location.line;
    // Line numbers count from 1, so index `line` is the line after the opening delimiter.
    const { location, delimiter } = step.docString;
    const close = lines.findIndex((l, i) => i >= location.line && l.trim() === delimiter);
    return close === -1 ? location.line : close + 1;
  };
  const { line, column = 1 } = scenario.location;
  const end = Math.max(
    line,
    ...scenario.steps.map(endOf),
    ...scenario.examples.map((ex) => (ex.tableBody.at(-1) ?? ex.tableHeader ?? ex).location.line),
  );
  return lines
    .slice(line - 1, end)
    .map((l) => l.slice(Math.min(column - 1, l.length - l.trimStart().length)))
    .join("\n");
}

const nodesByWorkflow = new WeakMap<object, OutlineNode[] | undefined>();

/** A workflow's outline, read once: its nodes, or undefined when its code cannot be outlined. */
function nodesOf(wf: Parameters<typeof outlineWorkflow>[0]): OutlineNode[] | undefined {
  if (!nodesByWorkflow.has(wf)) {
    const outline = outlineWorkflow(wf);
    nodesByWorkflow.set(wf, "nodes" in outline ? outline.nodes : undefined);
  }
  return nodesByWorkflow.get(wf);
}

type StepNode = Extract<OutlineNode, { kind: "op" | "approval" | "sleep" }>;

const isStep = (n: OutlineNode): n is StepNode => n.kind === "op" || n.kind === "approval" || n.kind === "sleep";

/**
 * The one step of the workflow's outline named `name` (an operation's call or a sleep by the
 * name it gives or its default, an approval by its title). Throws outside a scenario's workflow
 * (before its `When`, or in an operation's own test), when no step has the name, and when several
 * may: a name a call defaults to (its operation's id) can be several calls', and an unnamed call
 * with a computed segment is named in a run by the operation it calls, which may be this one.
 */
function stepNamed(scope: Scope, workflow: string | undefined, name: string): StepNode {
  if (workflow === undefined) {
    throw new Error(`step "${name}" names a step of a workflow: it goes after the When that runs one, in scenarios/`);
  }
  const nodes = nodesOf(scope.workflows.get(workflow)!);
  if (!nodes) throw new Error(`${workflow}'s code cannot be outlined, so its steps have no names`);
  const steps = flatten(nodes).filter(isStep);
  const named = steps.filter(
    (n) =>
      n.name === name || (n.kind === "op" && n.name === undefined && (n.ops?.includes(name) ?? fitsOp(n.id, name))),
  );
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    throw new Error(
      `${named.length} steps of ${workflow} are named "${name}": give the one to check a name of its own, such as \`{ name: "Publish the post" }\``,
    );
  }
  const names = [...new Set(steps.flatMap((n) => (n.name === undefined ? [] : [`"${n.name}"`])))];
  throw new Error(`no step of ${workflow} is named "${name}"; its steps are ${names.join(", ") || "none"}`);
}

/** The titles of the approvals in an outline, at any depth, where they are string literals. */
const titles = (nodes: OutlineNode[]): string[] =>
  nodes.flatMap((n) => {
    if (n.kind === "approval") return n.title === undefined ? [] : [n.title];
    if (n.kind === "all") return n.branches.flatMap(titles);
    if (n.kind === "branch") return n.cases.flatMap(titles);
    return n.kind === "each" || n.kind === "repeat" ? titles(n.body) : [];
  });

/** The literal titles of the approvals a workflow's code asks for, from its outline. */
const approvalsOf = (wf: Parameters<typeof outlineWorkflow>[0]) => [...new Set(titles(nodesOf(wf) ?? []))];

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
  for (const inFile of Map.groupBy(report.query.findAllPickles(), (p) => p.uri).values()) {
    const counts = Map.groupBy(inFile, (p) => p.name);
    for (const pickle of inFile) {
      const shared = pickle.astNodeIds.length > 1 && counts.get(pickle.name)!.length > 1;
      names.set(pickle.id, shared ? `${pickle.name} (line ${lineOf(report, pickle)})` : pickle.name);
    }
  }
  return names;
}

/** What one scenario's steps said, as compiling it records them. */
type Spec = Omit<Scenario, "workflow" | "approvals" | "file" | "line" | "text"> & { workflow?: string };

/** The run's records, as a `Then` step reads them. */
function viewOf(records: readonly LedgerRecord[]): RunView {
  type AnyOp<I, O> = Op<string, string, string, I, O>;
  // What the ledger holds a call took and returned is of its operation's types.
  const calls = <I, O>(op: AnyOp<I, O>) =>
    records
      .filter((r): r is CallRecord => isCall(r) && r.op === op.id && !r.error)
      .map(({ input, output }) => ({ input, output }) as Call<I, O>);
  const seeded = <I, O>(op: AnyOp<I, O>) =>
    records.flatMap((r) =>
      r.type === "scenario.seeded"
        ? r.seeds.flatMap((s) =>
            "op" in s && s.op === op.id ? [{ input: s.input, output: s.output } as Call<I, O>] : [],
          )
        : [],
    );
  return { records, calls, seeded, made: (op) => [...seeded(op), ...calls(op)] };
}

/** Where an operation's own test makes its calls: an operation's driver, live, replayed or a fake's, and the fake. */
export interface FeatureTarget {
  driver: Driver;
  /** The fake whose driver it is: a scenario's faults need one. */
  fake?: Fake<any, any>;
}

/** Why no step, or two, match a step's text. */
const noMatch = (built: Built, text: string) => `no step matches "${text}"\n${built.known}`;
const ambiguous = (text: string, sources: string[]) =>
  `"${text}" is ambiguous: it matches ${[...new Set(sources)].map((s) => `"${s}"`).join(" and ")}`;

/**
 * The rule a step's keyword picks among those registered with the expression it matched:
 * Cucumber matches the text alone, so one expression can be both a `Given` and a `Then`.
 */
function ruleFor(built: Built, expression: string, pickle: PickleStep): Rule {
  const kind = pickle.type && KINDS[pickle.type];
  if (!kind) throw new Error(`"${pickle.text}" needs a Given, When or Then before it`);
  const rules = built.byExpression
    .get(expression)!
    .filter((r) => r.kind === kind || r.kind === "any" || (r.kind === "actor" && kind === "given"));
  if (rules.length === 0) throw new Error(noMatch(built, pickle.text));
  if (rules.length > 1)
    throw new Error(
      ambiguous(
        pickle.text,
        rules.map((r) => r.source),
      ),
    );
  return rules[0]!;
}

/** Each scenario of a run, before its first step: one name always makes up the same values. */
function seedNames(report: Report, pickle: Pickle): string {
  const name = namesOf(report).get(pickle.id) ?? pickle.name;
  seedFrom(name);
  return name;
}

/** A World for compiling: each step records what it says into its scenario's spec, in `specs`. */
function compileWorld(built: Built, specs: Map<string, Spec>) {
  return (report: Report): SanomaWorld => {
    let spec: Spec;
    return {
      begin(pickle) {
        spec = { name: seedNames(report, pickle), steps: [], given: [], input: undefined, decisions: [], expect: [] };
        specs.set(pickle.id, spec);
      },
      step(expression, args, pickle) {
        const rule = ruleFor(built, expression, pickle);
        const { text } = pickle;
        const step: ScenarioStep = { text, kind: KINDS[pickle.type!]! };
        switch (rule.kind) {
          case "actor":
            if (spec.startedBy !== undefined)
              throw new Error(`${spec.startedBy} is acting already: a run has one actor`);
            spec.startedBy = rule.read(args, pickle);
            break;
          case "given": {
            const items = rule.read(args, pickle);
            spec.given.push(...items.map((item) => ({ step: text, ...item }) as Given));
            const [first] = items;
            if (first && "op" in first) step.op = first.op;
            if (items.some((i) => "fault" in i)) step.fault = true;
            break;
          }
          case "then": {
            const { expect } = rule.read(args, pickle, spec.workflow);
            spec.expect.push({ step: text, ...expect } as Expectation);
            if ("op" in expect && expect.op !== undefined) step.op = expect.op;
            if ("name" in expect) step.name = expect.name;
            if ("called" in expect && expect.called !== undefined) step.called = expect.called;
            if ("times" in expect) step.called = expect.times > 0;
            if ("decision" in expect) step.decision = expect.decision;
            break;
          }
          case "any":
            spec.decisions.push({ step: text, ...rule.read(args, pickle) });
            break;
          case "when": {
            if (spec.workflow !== undefined) throw new Error("a second When: a scenario runs its workflow once");
            const item = rule.read(args, pickle);
            if ("call" in item) {
              throw new Error(
                `"${text}" calls ${item.call} directly: a step for an operation's own test, in its connector's features`,
              );
            }
            Object.assign(spec, item);
          }
        }
        spec.steps.push(step);
      },
    };
  };
}

/**
 * A World for checking a run: each `Then` step judges the run on its own, and records its
 * verdict (why it does not hold, or undefined) in `verdicts`, by its pickle step's id, rather
 * than failing, so every `Then` runs. The other steps do nothing.
 */
function checkWorld(built: Built, workflow: string, view: RunView, verdicts: Map<string, string | undefined>) {
  return (report: Report): SanomaWorld => ({
    begin(pickle) {
      seedNames(report, pickle);
    },
    step(expression, args, pickle) {
      const rule = ruleFor(built, expression, pickle);
      if (rule.kind !== "then") return;
      const { verify } = rule.read(args, pickle, workflow);
      let detail: string | undefined;
      try {
        detail = verify(view);
      } catch (err) {
        if (isBug(err)) throw err;
        detail = errorMessage(err);
      }
      verdicts.set(pickle.id, detail);
    },
  });
}

/**
 * A World for an operation's own test: `Given` steps seed through the target, `When` steps call
 * its operations directly (no worker, no policy), and `Then` steps fail when they do not hold.
 */
function testWorld(built: Built, { driver, fake }: FeatureTarget) {
  return (report: Report): SanomaWorld => {
    // What the steps named (`as`), and the calls made, as a run's ledger would hold them.
    const values = new Map<string, unknown>();
    const records: LedgerRecord[] = [];
    let runId = "";
    // The test's own secrets, in memory: a driver resolves `secret()` markers against them.
    const secrets = memorySecrets();
    /** A record of the test, as a run's ledger would hold it. */
    const record = (body: Record<string, unknown>) => {
      const seq = records.length;
      const at = Date.now();
      const common = { v: 1, app: "test", runId, seq, at, actor: { id: "test" }, workflow: "" };
      records.push({ ...common, id: `${runId}:${body.type as string}:${seq}`, ...body } as LedgerRecord);
    };
    /** Calls an operation on the target, as the runtime would: the input parsed by its schema. */
    const call = (id: string, given: unknown) => {
      const op = built.scope.ops.get(id)!;
      const input = op.input.parse(resolve(given, values));
      const fn = driver.ops[`${op.resource}.${op.name}`];
      if (!fn) throw new Error(`the driver under test does not implement ${id}`);
      const context = { idempotencyKey: `${runId}:${records.length}`, runId, opId: id, attempt: 1, secrets };
      return { op, input, output: () => fn(input, context) };
    };
    return {
      begin(pickle) {
        runId = pickle.id;
        seedNames(report, pickle);
      },
      async step(expression, args, pickle) {
        const rule = ruleFor(built, expression, pickle);
        const { text } = pickle;
        switch (rule.kind) {
          case "given": {
            const seeds: { op: string; input: unknown; output: unknown }[] = [];
            for (const item of rule.read(args, pickle)) {
              if ("resource" in item) throw new Error(`"${text}" seeds a resource: a step for a sandbox run`);
              if ("fault" in item) {
                if (!fake) throw new Error(`"${text}" injects a fault, which only a fake can`);
                fake[item.fault](item.op);
                continue;
              }
              const made = call(item.op, item.input);
              const output = await made.output();
              if (item.as !== undefined) values.set(item.as, output);
              seeds.push({ op: item.op, input: made.input, output });
            }
            if (seeds.length) record({ type: "scenario.seeded", scenario: "", seeds });
            return;
          }
          case "when": {
            const item = rule.read(args, pickle);
            if ("workflow" in item) {
              throw new Error(
                `"${text}" runs a workflow: a step for a scenario in scenarios/, not an operation's own test`,
              );
            }
            const made = call(item.call, item.input);
            const started = Date.now();
            const result = await made.output().then(
              (output) => ({ output }),
              (err: unknown) => {
                if (isBug(err)) throw err;
                return { error: errorInfo(err) };
              },
            );
            const { op, input } = made;
            const durationMs = Date.now() - started;
            record({
              type: "op.called",
              op: op.id,
              effect: op.effect,
              input,
              decision: { kind: "allow" },
              durationMs,
              ...result,
            });
            return;
          }
          case "any":
            throw new Error(
              `"${text}" decides an approval: a step for a scenario in scenarios/, not an operation's own test`,
            );
          case "actor":
            throw new Error(`"${text}" says who starts a run: a step for a scenario in scenarios/`);
          case "then": {
            const detail = rule.read(args, pickle).verify(viewOf(records));
            if (detail !== undefined) throw new Error(detail);
          }
        }
      },
    };
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

/** A step's `file:line`. */
const whereOf = (report: Report, file: string, step: PickleStep) =>
  `${file}:${report.query.findStepBy(step)?.location.line ?? 1}`;

/**
 * Why a step that did not pass did not, at `where`: the error it failed with, no step matching
 * it (with the steps there are), or more than one; undefined for a step that passed or did not run.
 */
function stepError(built: Built, result: StepResult | undefined, step: PickleStep, where: string) {
  if (!result) return undefined;
  switch (result.status) {
    case StepStatus.PASSED:
    case StepStatus.SKIPPED:
      return undefined;
    case StepStatus.UNDEFINED:
      return step.type && KINDS[step.type]
        ? `${where}: ${noMatch(built, step.text)}`
        : `${where}: "${step.text}" needs a Given, When or Then before it`;
    case StepStatus.AMBIGUOUS:
      return `${where}: ${ambiguous(
        step.text,
        result.matches.flatMap((e) => built.byExpression.get(e)!.map((r) => r.source)),
      )}`;
    default:
      return `${where}: ${result.message ?? `the step ended ${result.status}`}`;
  }
}

/** The `.feature` files under `dir`, relative to it, with `/` between directories, in order. */
function featureFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".feature"))
    .map((f) => f.replaceAll("\\", "/"))
    .toSorted();
}

/** What `loadScenarios` returns. */
export interface LoadedScenarios {
  scenarios: Scenario[];
  errors: { file: string; message: string }[];
}

/** A parse error, as a file's error: `file:line: message`. */
const parseErrorOf = ({ uri, line, message }: Report["parseErrors"][number]) =>
  `${uri}${line === undefined ? "" : `:${line}`}: ${message}`;

/**
 * Compiles the feature files `files` (relative to `dir`) into scenarios: Cucumber runs each,
 * and its steps record what they say. A file with an error has none of its scenarios: the
 * first error in it (a step that fails or matches no step or two, a scenario with no `When`,
 * a name used twice, a file Gherkin cannot parse, no scenarios at all) is its error.
 */
async function compile(scope: Scope, dir: string, files: string[]): Promise<LoadedScenarios> {
  const built = builtFor(scope);
  const errors = new Map<string, string>();
  const specs = new Map<string, Spec>();
  let report: Report | undefined;
  let left = files;
  // A file Gherkin cannot parse stops the whole run: it is left out, and the rest run again.
  while (left.length) {
    report = await runFeatures(built.library, compileWorld(built, specs), { cwd: dir, files: left, isBug });
    if (report.parseErrors.length === 0) break;
    for (const error of report.parseErrors) {
      if (!errors.has(error.uri)) errors.set(error.uri, parseErrorOf(error));
    }
    const rest = left.filter((f) => !errors.has(f));
    // An error of no file left: give it to every file, rather than run them again forever.
    if (rest.length === left.length) {
      for (const f of left) errors.set(f, report.parseErrors.map(parseErrorOf).join("; "));
    }
    left = rest.length === left.length ? [] : rest;
    report = undefined;
  }
  const scenarios: Scenario[] = [];
  if (report) {
    const { query } = report;
    const names = namesOf(report);
    const results = stepResults(report);
    const pickles = Map.groupBy(query.findAllPickles(), (p) => p.uri);
    for (const file of files) {
      if (errors.has(file)) continue;
      const inFile: Scenario[] = [];
      try {
        const list = pickles.get(file) ?? [];
        if (list.length === 0) throw new Error(`${file}: no scenarios; add one with "Scenario: <name>"`);
        for (const pickle of list) {
          const line = lineOf(report, pickle);
          const scenario = query.findLineageBy(pickle)!.scenario!;
          const where = `${file}:${scenario.location.line}`;
          for (const step of pickle.steps) {
            const error = stepError(built, results.get(step.id), step, whereOf(report, file, step));
            if (error) throw new Error(error);
          }
          const { workflow, ...spec } = specs.get(pickle.id)!;
          const name = names.get(pickle.id)!;
          if (inFile.some((s) => s.name === name)) {
            throw new Error(`${where}: a second scenario named "${name}"; give each its own name`);
          }
          if (workflow === undefined) {
            throw new Error(
              `${where}: scenario "${name}" has no When: say which workflow runs, such as "When <workflow> runs with"`,
            );
          }
          // A step about a declared resource reads the report of the built-in it is about.
          for (const e of spec.expect) {
            const reads: string = "declared" in e ? ("status" in e ? DRIFT_WORKFLOW : APPLY_WORKFLOW) : workflow;
            if (reads !== workflow) {
              throw new Error(
                `${where}: "${e.step}" reads ${reads === DRIFT_WORKFLOW ? "a drift" : "an apply"} report, so the scenario must run ${reads}, not ${workflow}`,
              );
            }
          }
          inFile.push({
            ...spec,
            name,
            file,
            line,
            workflow,
            text: textOf(scenario, report.texts.get(file) ?? ""),
            approvals: approvalsOf(scope.workflows.get(workflow)!),
          });
        }
      } catch (err) {
        if (isBug(err)) throw err;
        errors.set(file, errorMessage(err));
        continue;
      }
      scenarios.push(...inFile);
    }
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
 * Each scope's scenarios as last read, with the stamp of the files they were read from and the
 * people they were checked against (`readPeople`'s answer, the same object until a data file
 * changes). By scope, since what a file means depends on its operations and workflows.
 */
const loadedByScope = new WeakMap<
  Scope,
  { stamp: string; people: DeclaredPeople | undefined; loaded: Promise<LoadedScenarios> }
>();

/**
 * Every scenario in the `.feature` files under `scenarios` (a `file:` URL to a directory),
 * compiled by Cucumber, with an error for each file that does not compile and each name used
 * twice. No directory, or none given, is no scenarios. Rejects when an operation's phrase names
 * a field it lacks. The files are compiled again only once one is added, removed or written
 * (its name, `mtimeMs` or size changes), or the people's data files change: until then each
 * call returns the same object, which callers must not change.
 */
export async function loadScenarios(scope: Scope): Promise<LoadedScenarios> {
  if (!scope.scenarios) return { scenarios: [], errors: [] };
  const dir = fileURLToPath(scope.scenarios);
  if (!existsSync(dir)) return { scenarios: [], errors: [] };
  // Built first, so a phrase naming a field its input lacks rejects even with no feature files.
  builtFor(scope);
  const files = featureFiles(dir);
  const stamp = JSON.stringify([
    dir,
    files.map((file) => {
      const { mtimeMs, size } = statSync(join(dir, file));
      return [file, mtimeMs, size];
    }),
  ]);
  // None without a root, which declares no one.
  const people = scope.root === undefined ? undefined : readPeople(scope.root);
  const cached = loadedByScope.get(scope);
  if (cached?.stamp === stamp && cached.people === people) return cached.loaded;
  const loaded = files.length ? compile(scope, dir, files) : Promise.resolve({ scenarios: [], errors: [] });
  loadedByScope.set(scope, { stamp, people, loaded });
  // A compile that throws (a bug) is not kept: the next call tries again.
  loaded.catch(() => {
    if (loadedByScope.get(scope)?.loaded === loaded) loadedByScope.delete(scope);
  });
  return loaded;
}

/**
 * Checks a run's ledger records against the scenario, as its feature file reads now: Cucumber
 * runs the scenario's `Then` steps, each judging the run on its own, and the rest of its steps
 * do nothing. One check per expectation (`scenario.expect`), in order, a step that does not hold
 * with why as its `detail`. Rejects when the scenario no longer compiles as it did (a step the
 * file no longer matches, say): load the scenarios again first, as the app does.
 */
export async function check(scope: Scope, scenario: Scenario, records: readonly LedgerRecord[]): Promise<Check[]> {
  if (!scope.scenarios) throw new Error(`No scenarios directory to check scenario "${scenario.name}" from`);
  const built = builtFor(scope);
  const { file, line, name } = scenario;
  const verdicts = new Map<string, string | undefined>();
  const report = await runFeatures(built.library, checkWorld(built, scenario.workflow, viewOf(records), verdicts), {
    cwd: fileURLToPath(scope.scenarios),
    files: [file],
    line,
    isBug,
  });
  const where = `${file}:${line}`;
  if (report.parseErrors.length) throw new Error(`${where}: ${report.parseErrors.map((e) => e.message).join("; ")}`);
  const names = namesOf(report);
  const pickle = report.query
    .findAllPickles()
    .find((p) => p.uri === file && lineOf(report, p) === line && names.get(p.id) === name);
  if (!pickle) throw new Error(`${where}: no scenario "${name}" there now`);
  const results = stepResults(report);
  const checks: Check[] = [];
  for (const step of pickle.steps) {
    const expectation = scenario.expect[checks.length];
    // Only a `Then` step expects: a `Given` can read the same as one (`{op} was called with`).
    if (expectation?.step === step.text && KINDS[step.type!] === "then" && verdicts.has(step.id)) {
      checks.push(verdict(step.text, verdicts.get(step.id)));
      continue;
    }
    const error = stepError(built, results.get(step.id), step, whereOf(report, file, step));
    if (error) throw new Error(error);
  }
  if (checks.length !== scenario.expect.length) {
    throw new Error(`${where}: scenario "${name}" no longer has the expectations it was read with`);
  }
  return checks;
}

/**
 * The scenarios of the `.feature` files under `dir` (a `file:` URL to a directory), in order,
 * named as `loadScenarios` names them, from a dry run: what a test runner lists before it runs
 * each (`testFeature`). Rejects, naming the file, for one Gherkin cannot parse.
 */
export async function featureScenarios(
  scope: Scope,
  dir: URL,
): Promise<{ file: string; line: number; name: string; tags: string[] }[]> {
  const cwd = fileURLToPath(dir);
  const report = await runFeatures(builtFor(scope).library, () => ({ begin() {}, step() {} }), {
    cwd,
    files: featureFiles(cwd),
    dryRun: true,
    isBug,
  });
  if (report.parseErrors.length) throw new Error(report.parseErrors.map(parseErrorOf).join("\n"));
  const names = namesOf(report);
  return report.query.findAllPickles().map((pickle) => ({
    file: pickle.uri,
    line: lineOf(report, pickle),
    name: names.get(pickle.id)!,
    tags: pickle.tags.map((t) => t.name),
  }));
}

/**
 * Runs the scenario at `line` of the feature file `file` (absolute) as an operation's own test,
 * on the target: its `Given` steps seed through it, its `When` steps call its operations directly
 * (no worker, no policy), and its `Then` steps check those calls. Rejects with its first step
 * that did not pass, at `file:line`.
 */
export async function testFeature(scope: Scope, file: string, line: number, target: FeatureTarget): Promise<void> {
  const built = builtFor(scope);
  const name = basename(file);
  const report = await runFeatures(built.library, testWorld(built, target), {
    cwd: dirname(file),
    files: [name],
    line,
    isBug,
  });
  if (report.parseErrors.length) throw new Error(report.parseErrors.map(parseErrorOf).join("\n"));
  const results = stepResults(report);
  for (const pickle of report.query.findAllPickles()) {
    for (const step of pickle.steps) {
      const error = stepError(built, results.get(step.id), step, whereOf(report, name, step));
      if (error) throw new Error(error);
    }
  }
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
