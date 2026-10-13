import { Writable } from "node:stream";
import { supportCodeLibraryBuilder } from "@cucumber/cucumber";
import { type IRunOptions, type ISupportCodeLibrary, runCucumber } from "@cucumber/cucumber/api";
import {
  type Envelope,
  type GherkinDocument,
  IdGenerator,
  type Pickle,
  type PickleStep,
  TestStepResultStatus,
} from "@cucumber/messages";
import {
  CucumberExpression,
  type Node,
  NodeType,
  ParameterType,
  ParameterTypeRegistry,
} from "@cucumber/cucumber-expressions";

/*
 * Cucumber, as Sanoma runs it: a support code library built from data (never from files it
 * imports), and runs of feature files in this process, one after another, read back from
 * Cucumber's messages. Internal: `scenario.ts` says what the steps mean. Server-side only.
 *
 * Each step definition's code hands the step to the run's World (`SanomaWorld.step`), so one
 * library serves every kind of run (compiling a scenario, checking a run, an operation's own
 * test): only the World differs, and each run gets a World class of its own.
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
  /** Runs one step: `expression` is the index of the expression it matched, `values` its parameters. */
  step(expression: number, values: unknown[], pickleStep: PickleStep): unknown;
}

/** A finalized library and the expressions its step definitions were made from, in order. */
export interface Library {
  support: ISupportCodeLibrary;
  expressions: readonly string[];
}

/**
 * Builds a support code library: the parameter types, then one step definition per expression,
 * each handing its step to the World. Cucumber keeps one builder per process, so the library is
 * built here, by hand, in one synchronous stretch (`reset`, register, `finalize`): building it
 * again in the same process gives the same definitions, where a second `loadSupport` would
 * import nothing new and find none.
 */
export function buildLibrary(parameterTypes: readonly ParameterTypeSpec[], expressions: readonly string[]): Library {
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
  // The parameters each expression has, to give each definition's code the length Cucumber checks.
  const registry = new ParameterTypeRegistry();
  for (const { name, regexp, transformer } of parameterTypes) {
    registry.defineParameterType(new ParameterType(name, regexp as RegExp, null, transformer, false));
  }
  expressions.forEach((source, index) => {
    defineStep(source, stepCode(index, countParameters(new CucumberExpression(source, registry).ast)));
  });
  Before(function (this: Current, { pickle }) {
    this.begin(pickle);
  });
  BeforeStep(function (this: Current, { pickleStep }) {
    this.current = pickleStep;
  });
  return { support: builder.finalize(), expressions: [...expressions] };
}

/** The World as the library's code sees it: the run's, with the step being run. */
type Current = SanomaWorld & { current: PickleStep };

const countParameters = (node: Node): number =>
  node.type === NodeType.parameter ? 1 : (node.nodes ?? []).reduce((n, child) => n + countParameters(child), 0);

/**
 * A step definition's code. Cucumber passes the expression's values, then the step's doc string
 * or table when it has one, then a callback, and checks the code's `length` against what it
 * passes: one more than the parameters takes the callback of a step with no argument (the
 * callback interface), and the argument of a step that has one (the promise interface). The
 * World reads the argument from the pickle step, so the code answers both.
 */
function stepCode(index: number, parameters: number) {
  const code = function (this: Current, ...args: unknown[]) {
    const values = args.slice(0, parameters);
    const result = Promise.resolve().then(() => this.step(index, values, this.current));
    if (args.length > parameters + 1) return result;
    const done = args.at(-1) as Done;
    result.then(
      (value) => done(null, value),
      (err: unknown) => done(err),
    );
    return undefined;
  };
  Object.defineProperty(code, "length", { value: parameters + 1 });
  return code;
}

type Done = (error: unknown, result?: unknown) => void;

/** How one step ended. */
export interface StepResult {
  status: TestStepResultStatus;
  /** Why it failed: its error's message. */
  message?: string;
  /** The indexes of the expressions that match it: none for an undefined step, more than one for an ambiguous one. */
  matches: number[];
}

/** What a run read: the files, their pickles, and how each step ended. */
export interface Report {
  /** Each file's text and document, by its path relative to the run's `cwd`. */
  sources: Map<string, { text: string; document?: GherkinDocument }>;
  pickles: Pickle[];
  /** By pickle step id; a step of a pickle that did not run has none. */
  steps: Map<string, StepResult>;
  /** Files Gherkin could not parse; none of the run's scenarios ran when there are any. */
  parseErrors: { uri: string; line?: number; message: string }[];
}

/** A stream that drops what it is given: Cucumber's formatters and logger write nowhere. */
const sink = () =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

/**
 * Runs the feature files at `paths` (absolute, or relative to `cwd`; `file:line` runs the
 * scenario or examples row at that line) with the library, serially, in this process, and reads
 * back what happened. `makeWorld` makes each scenario's World, given the report so far (every
 * file and pickle, read before the first scenario starts). A step's error that is a bug in code (`isBug`)
 * is rethrown once the run is over, rather than reported as the step's failure.
 */
export async function runFeatures(
  library: Library,
  makeWorld: (report: Report) => SanomaWorld,
  { cwd, paths, isBug }: { cwd: string; paths: string[]; isBug: (err: unknown) => boolean },
): Promise<Report> {
  const report: Report = { sources: new Map(), pickles: [], steps: new Map(), parseErrors: [] };
  let bug: unknown;
  const caught = (err: unknown) => {
    if (isBug(err)) bug ??= err;
    throw err;
  };
  // A World for each scenario, made when it starts: by then the run has read every pickle.
  class RunWorld {
    readonly world = makeWorld(report);
    current?: PickleStep;
    begin(pickle: Pickle) {
      this.world.begin(pickle);
    }
    step(expression: number, values: unknown[], pickleStep: PickleStep): unknown {
      try {
        const result = this.world.step(expression, values, pickleStep);
        return result instanceof Promise ? result.catch(caught) : result;
      } catch (err) {
        return caught(err);
      }
    }
  }
  const support = { ...library.support, World: RunWorld } as ISupportCodeLibrary;
  const configuration: IRunOptions = {
    sources: { defaultDialect: "en", paths, names: [], tagExpression: "", order: "defined" },
    support,
    runtime: {
      dryRun: false,
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
  const definitions = new Map<string, number>();
  const testSteps = new Map<string, { pickleStepId: string; matches: number[] }>();
  const byExpression = new Map(library.expressions.map((source, index) => [source, index]));
  const onMessage = (envelope: Envelope) => {
    const { source, gherkinDocument, pickle, parseError, stepDefinition, testCase, testStepFinished } = envelope;
    if (source) report.sources.set(source.uri, { text: source.data });
    else if (gherkinDocument?.uri) report.sources.get(gherkinDocument.uri)!.document = gherkinDocument;
    else if (pickle) report.pickles.push(pickle);
    else if (parseError) {
      const { uri = "", location } = parseError.source;
      report.parseErrors.push({ uri, ...(location && { line: location.line }), message: parseError.message });
    } else if (stepDefinition) {
      const index = byExpression.get(stepDefinition.pattern.source);
      if (index !== undefined) definitions.set(stepDefinition.id, index);
    } else if (testCase) {
      for (const { id, pickleStepId, stepDefinitionIds = [] } of testCase.testSteps) {
        if (pickleStepId) {
          testSteps.set(id, { pickleStepId, matches: stepDefinitionIds.map((d) => definitions.get(d)!) });
        }
      }
    } else if (testStepFinished) {
      const step = testSteps.get(testStepFinished.testStepId);
      if (!step) return;
      const { status, message, exception } = testStepFinished.testStepResult;
      const why = exception?.message ?? message;
      report.steps.set(step.pickleStepId, {
        status,
        matches: step.matches,
        ...(why !== undefined && { message: why }),
      });
    }
  };
  await runCucumber(configuration, { cwd, stdout: sink(), stderr: sink(), env: {} }, onMessage);
  if (bug !== undefined) throw bug;
  return report;
}

export { TestStepResultStatus as StepStatus };
