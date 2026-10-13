import { Writable } from "node:stream";
import { supportCodeLibraryBuilder } from "@cucumber/cucumber";
import { type IRunOptions, type ISupportCodeLibrary, runCucumber } from "@cucumber/cucumber/api";
import { type CucumberExpression, type Node, NodeType } from "@cucumber/cucumber-expressions";
import { IdGenerator, type Pickle, type PickleStep, TestStepResultStatus } from "@cucumber/messages";
import { Query } from "@cucumber/query";

/*
 * Cucumber, as Sanoma runs it: a support code library built from data (never from files it
 * imports), and runs of feature files in this process, one after another, read back through
 * Cucumber's own `Query` of its messages. Internal: `scenario.ts` says what the steps mean.
 * Server-side only.
 *
 * Each step definition's code hands the step to the run's World (`SanomaWorld.step`), so one
 * library serves every kind of run (compiling a scenario, checking a run, an operation's own
 * test): only the World differs, and each run makes its own.
 */

/** A parameter type the steps' expressions use, as Cucumber's `defineParameterType` takes it. */
export interface ParameterTypeSpec {
  name: string;
  regexp: RegExp | string | readonly (RegExp | string)[];
  transformer: (...match: string[]) => unknown;
}

/** What one run does with its scenarios' steps. */
export interface SanomaWorld {
  /** Called before the scenario's first step. */
  begin(pickle: Pickle): void;
  /** Runs one step: `expression` is the expression it matched, `values` its parameters. */
  step(expression: string, values: unknown[], pickleStep: PickleStep): unknown;
}

/**
 * Builds a support code library: the parameter types, then one step definition per expression,
 * each handing its step to the World. Cucumber keeps one builder per process, so the library is
 * built here, by hand, in one synchronous stretch (`reset`, register, `finalize`): building it
 * again in the same process gives the same definitions, where a second `loadSupport` would
 * import nothing new and find none.
 */
export function buildLibrary(
  parameterTypes: readonly ParameterTypeSpec[],
  expressions: Iterable<string>,
): ISupportCodeLibrary {
  const builder = supportCodeLibraryBuilder;
  builder.reset(process.cwd(), IdGenerator.uuid(), {
    requireModules: [],
    requirePaths: [],
    importPaths: [],
    loaders: [],
  });
  const { defineParameterType, defineStep, Before, BeforeStep } = builder.methods;
  for (const { name, regexp, transformer } of parameterTypes) {
    defineParameterType({ name, regexp: regexp as RegExp, transformer, useForSnippets: false });
  }
  for (const expression of expressions) defineStep(expression, stepCode(expression));
  Before(function (this: Current, { pickle }) {
    if (this.run.skips(pickle)) return "skipped";
    this.begin(pickle);
    return undefined;
  });
  BeforeStep(function (this: Current, { pickleStep }) {
    this.current = pickleStep;
  });
  const library = builder.finalize();
  // Cucumber checks a definition's code's `length` against what it passes: the expression's
  // parameters, then the step's doc string or table, or else a callback. Its own parse of each
  // expression says how many parameters it has.
  for (const { code, expression } of library.stepDefinitions) {
    Object.defineProperty(code, "length", {
      value: countParameters((expression as CucumberExpression).ast) + 1,
    });
  }
  return library;
}

/** The World as the library's code sees it: the run's, with the run's state and the step being run. */
type Current = SanomaWorld & { current: PickleStep; run: RunState };

/** What a run's Worlds share: which scenarios it skips, and where a bug in a step's code goes. */
interface RunState {
  skips(pickle: Pickle): boolean;
  caught(err: unknown): void;
}

const countParameters = (node: Node): number =>
  node.type === NodeType.parameter ? 1 : (node.nodes ?? []).reduce((n, child) => n + countParameters(child), 0);

/**
 * A step definition's code. Cucumber passes the expression's values, then the step's doc string
 * or table when it has one, then a callback: with one more argument than the parameters it took
 * the callback of a step with no argument (the callback interface), and with two more, the
 * argument of a step that has one (the promise interface). The World reads the argument from
 * the pickle step, so the code answers both.
 */
function stepCode(expression: string) {
  const code = function (this: Current, ...args: unknown[]) {
    const parameters = code.length - 1;
    const result = Promise.resolve()
      .then(() => this.step(expression, args.slice(0, parameters), this.current))
      .catch((err: unknown) => {
        this.run.caught(err);
        throw err;
      });
    if (args.length > parameters + 1) return result;
    const done = args.at(-1) as (error: unknown, result?: unknown) => void;
    result.then(
      (value) => done(null, value),
      (err: unknown) => done(err),
    );
    return undefined;
  };
  return code;
}

/** How one step ended. */
export interface StepResult {
  status: TestStepResultStatus;
  /** Why it failed: its error's message. */
  message?: string;
  /** The expressions that match it: none for an undefined step, more than one for an ambiguous one. */
  matches: string[];
}

/** What a run read: Cucumber's `Query` of its messages, each file's text, and the files Gherkin could not parse. */
export interface Report {
  query: Query;
  /** Each file's text, by its path relative to the run's `cwd`. */
  texts: Map<string, string>;
  /** Files Gherkin could not parse; none of the run's scenarios ran when there are any. */
  parseErrors: { uri: string; line?: number; message: string }[];
}

/** How each step of a run ended, by its pickle step's id; a step of a pickle that did not run has none. */
export function stepResults({ query }: Report): Map<string, StepResult> {
  const results = new Map<string, StepResult>();
  for (const finished of query.findAllTestStepFinished()) {
    const testStep = query.findTestStepBy(finished);
    if (!testStep?.pickleStepId) continue;
    const { status, message, exception } = finished.testStepResult;
    const why = exception?.message ?? message;
    results.set(testStep.pickleStepId, {
      status,
      matches: query.findStepDefinitionsBy(testStep).map((d) => d.pattern.source),
      ...(why !== undefined && { message: why }),
    });
  }
  return results;
}

/** A pickle's line: its examples row's, or its scenario's. */
export const lineOf = (report: Report, pickle: Pickle) => report.query.findLocationOf(pickle)?.line ?? 1;

/** A stream that drops what it is given: Cucumber's formatters and logger write nowhere. */
const sink = () =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

/**
 * A path as a glob that matches it alone: Cucumber globs each path it is given, and reads one
 * whose name starts with `@` as a list of paths. Brackets escape what they can; brace
 * expansion reads braces and commas before brackets, so those (and backslashes) match any
 * character instead.
 */
const literal = (path: string) => path.replaceAll(/[*?[\]()+@]/g, "[$&]").replaceAll(/[{},\\]/g, "?");

/**
 * Runs the feature files `files` (relative to `cwd`) with the library, serially, in this
 * process, and reads back what happened. `line`, with a single file, runs only the scenario or
 * examples row at that line. `makeWorld` makes each scenario's World, given the report so far
 * (every file and pickle, read before the first scenario starts). A dry run matches the steps
 * and runs none. A step's error that is a bug in code (`isBug`) is rethrown once the run is
 * over, rather than reported as the step's failure.
 */
export async function runFeatures(
  library: ISupportCodeLibrary,
  makeWorld: (report: Report) => SanomaWorld,
  {
    cwd,
    files,
    line,
    dryRun = false,
    isBug,
  }: { cwd: string; files: string[]; line?: number; dryRun?: boolean; isBug: (err: unknown) => boolean },
): Promise<Report> {
  const report: Report = { query: new Query(), texts: new Map(), parseErrors: [] };
  let bug: unknown;
  const run: RunState = {
    skips: (pickle) => line !== undefined && lineOf(report, pickle) !== line,
    caught: (err) => {
      if (isBug(err)) bug ??= err;
    },
  };
  // Cucumber makes a scenario's World with `new`: a constructor that returns an object gives that object.
  function World() {
    return Object.assign(makeWorld(report), { run });
  }
  const configuration: IRunOptions = {
    sources: { defaultDialect: "en", paths: files.map(literal), names: [], tagExpression: "", order: "defined" },
    support: { ...library, World } as ISupportCodeLibrary,
    runtime: {
      dryRun,
      failFast: false,
      filterStacktraces: true,
      parallel: 0,
      retry: 0,
      retryTagFilter: "",
      strict: true,
      worldParameters: {},
    },
    // Cucumber always formats to stdout, here a sink: `rerun` is the formatter that does least.
    formats: { stdout: "rerun", files: {}, publish: false, options: {} },
  };
  await runCucumber(configuration, { cwd, stdout: sink(), stderr: sink(), env: {} }, (envelope) => {
    report.query.update(envelope);
    const { source, parseError } = envelope;
    if (source) report.texts.set(source.uri, source.data);
    if (parseError) {
      const { uri = "", location } = parseError.source;
      report.parseErrors.push({ uri, ...(location && { line: location.line }), message: parseError.message });
    }
  });
  if (bug !== undefined) throw bug;
  return report;
}

export { TestStepResultStatus as StepStatus };
