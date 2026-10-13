import type { LedgerRecord } from "./ledger.ts";
import type { Op } from "./op.ts";

/*
 * Steps a connector (or a company) ships for its Gherkin tests, as plain data: expressions and
 * functions, never Cucumber's own registration, which Sanoma does from the config. Kept free of
 * Cucumber, Gherkin and faker, so a connector's package can import it on its main entry.
 */

/** A fault a fake injects into its next call to an operation. */
export type Fault = "failNext" | "rateLimit" | "loseReply";

/** An operation, or its id. */
export type OpRef = Op | string;

/**
 * What a `Given` step sets up before the run: a call through an operation of the run's fake,
 * with the fields of its input to set (the rest is made up), or a fault to inject into its next
 * call. `as` names a call's output, so a later step's table of an operation's own test can use
 * its fields: `$draft.id`.
 */
export type Seed = { op: OpRef; input: Record<string, unknown>; as?: string } | { op: OpRef; fault: Fault };

/** A call in a run: an `op.called` record. */
export type CallRecord = Extract<LedgerRecord, { type: "op.called" }>;

/** A run as a `Then` step reads it. */
export interface RunView {
  /** Every record of the run, in order. */
  readonly records: readonly LedgerRecord[];
  /** The calls the run made to the operation, in order: those without an `error`. */
  calls(op: OpRef): CallRecord[];
  /** What the scenario's `Given` steps seeded through the operation, with what each call returned. */
  seeded(op: OpRef): { input: unknown; output: unknown }[];
}

/**
 * What a `Then` step expects. `check` reads the run and throws, or returns why the expectation
 * does not hold; returning nothing passes. `op` and `called` say what the step is about, for the
 * graph: the operation, and whether it expects a call to it (true) or rules one out (false).
 */
export interface Expect {
  op?: OpRef;
  called?: boolean;
  check(run: RunView): string | undefined | void;
}

/**
 * A step's function gets the values of its expression's parameters, in order, then the step's
 * doc string or table when it has one: `{ docString }`, or `{ table }`, the table's rows of cells.
 */
export interface StepArgument {
  docString?: string;
  table?: string[][];
}

/** One step definition: a Cucumber expression, and what the step says. */
export type StepDefinition =
  | { kind: "given"; expression: string; fn: (...args: any[]) => Seed | Seed[] }
  | { kind: "then"; expression: string; fn: (...args: any[]) => Expect };

/** A connector's or a company's steps: `owner` (the vendor, say) heads them in a list of known steps. */
export interface Steps {
  readonly owner: string;
  readonly steps: readonly StepDefinition[];
}

/**
 * Declares steps for Gherkin tests, as data the config's scenarios and a connector's own feature
 * files can use: `given` steps say what to seed (`Seed`), `then` steps what to expect
 * (`Expect`). A step's function must be pure: compiling a scenario calls it, and so does the app,
 * whenever a feature file changes.
 *
 * ```ts
 * export const ghostSteps = defineSteps("ghost", ({ given }) => {
 *   given("a Ghost draft titled {string}", (title: string) => ({ op: ghostOps.post.create, input: { title }, as: "draft" }));
 * });
 * ```
 */
export function defineSteps(
  owner: string,
  define: (steps: {
    given(expression: string, fn: (...args: any[]) => Seed | Seed[]): void;
    then(expression: string, fn: (...args: any[]) => Expect): void;
  }) => void,
): Steps {
  const steps: StepDefinition[] = [];
  define({
    given: (expression, fn) => void steps.push({ kind: "given", expression, fn }),
    // Named for Gherkin's keyword; the object goes to `define` only, which never awaits it.
    // oxlint-disable-next-line unicorn/no-thenable
    then: (expression, fn) => void steps.push({ kind: "then", expression, fn }),
  });
  return Object.freeze({ owner, steps: Object.freeze(steps) });
}

/** The id of an operation given as itself or by id. */
export const opId = (op: OpRef): string => (typeof op === "string" ? op : op.id);
