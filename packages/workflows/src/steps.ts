import type { LedgerRecord } from "./ledger.ts";
import type { Op } from "./op.ts";

/*
 * Steps a connector (or a company) ships for its Gherkin tests, as plain data: expressions and
 * functions, never Cucumber's own registration, which Sanoma does from the config. Kept free of
 * Cucumber, Gherkin and faker, so a connector's package can import it on its main entry.
 */

/** Any operation, whatever its input and output. */
type AnyOp<I = any, O = any> = Op<string, string, string, I, O>;

/**
 * What a `Given` step sets up before the run: a call through an operation of the run's fake,
 * with the fields of its input to set (the rest is made up), or a fault to inject into its next
 * call. `as` names a call's output, so a later step's table of an operation's own test can use
 * its fields: `$draft.id`.
 */
export type Seed =
  | { op: AnyOp; input: Record<string, unknown>; as?: string }
  | { op: AnyOp; fault: "failNext" | "rateLimit" | "loseReply" };

/** A call through an operation: what it was given, and what it returned. */
export interface Call<I, O> {
  input: I;
  output: O;
}

/** A run as a `Then` step reads it. */
export interface RunView {
  /** Every record of the run, in order. */
  readonly records: readonly LedgerRecord[];
  /** The calls the run made through the operation, in order: those that did not fail. */
  calls<I, O>(op: AnyOp<I, O>): Call<I, O>[];
  /** The calls the scenario's `Given` steps made through the operation, to seed the run's fake. */
  seeded<I, O>(op: AnyOp<I, O>): Call<I, O>[];
  /** The seeded calls, then the run's own: everything made through the operation. */
  made<I, O>(op: AnyOp<I, O>): Call<I, O>[];
}

/**
 * What a `Then` step expects. `check` reads the run and throws, or returns why the expectation
 * does not hold; returning nothing passes. `op` and `called` say what the step is about, for the
 * graph: the operation, and whether it expects a call to it (true) or rules one out (false).
 */
export interface Expect {
  op?: AnyOp;
  called?: boolean;
  check(run: RunView): string | undefined | void;
}

/** One step definition: a Cucumber expression, and what the step says, from its parameters' values. */
export type StepDefinition =
  | { kind: "given"; expression: string; fn: (...values: any[]) => Seed }
  | { kind: "then"; expression: string; fn: (...values: any[]) => Expect };

/** A connector's or a company's steps: `owner` (the vendor, say) heads them in a list of known steps. */
export interface Steps {
  readonly owner: string;
  readonly steps: readonly StepDefinition[];
}

/**
 * Declares steps for Gherkin tests, as data the config's scenarios and a connector's own feature
 * files can use: `given` steps say what to seed (`Seed`), `then` steps what to expect
 * (`Expect`). A step's function gets its expression's values, in order, and must be pure:
 * compiling a scenario calls it, and so does the app, whenever a feature file changes.
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
    given(expression: string, fn: (...values: any[]) => Seed): void;
    then(expression: string, fn: (...values: any[]) => Expect): void;
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
