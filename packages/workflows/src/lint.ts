import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { byPosition, childrenOf, type LintProblem, type Node, parsed, type SourceFile } from "./ast.ts";
import { COLLECTIONS_FILE, readDataFile } from "./datafile.ts";
import { constsOf, outlineBody, workflowLiterals } from "./outline.ts";
import { inside, nearestDir, RELATIVE } from "./paths.ts";
// From src/ and from dist/ alike, the package's own oxlint.json: the one list of allowed names.
import oxlint from "../oxlint.json" with { type: "json" };

export type { LintProblem } from "./ast.ts";

/**
 * A workflow must call vendors through `ctx`, so the policy sees every call. These are the
 * import rules oxlint's built-in rules cannot express; the clock, randomness, the network
 * and the environment are oxlint's (the package's `oxlint.json`).
 */
const THROUGH_CTX = "a workflow must call vendors through ctx, so the policy sees every call";

/**
 * The packages the author surface is imported from, each allowing the same names: `sanoma`
 * re-exports what `@sanoma-ai/workflows` allows (and `z`). Adding one here accepts it.
 */
const AUTHOR_PACKAGES: readonly string[] = ["@sanoma-ai/workflows", "sanoma"];

/** The packages a workflow may import from at all: the author packages, connectors and zod. */
const ALLOWED_PACKAGE = new RegExp(`^(${[...AUTHOR_PACKAGES, "@sanoma-ai/connector-[a-z0-9-]+", "zod"].join("|")})$`);

/** Packages refused by name, with the reason. */
const REFUSED_PACKAGES: [RegExp, string][] = [
  [/^@sanoma-ai\/testing(\/|$)/, `fakes and test helpers belong in tests; ${THROUGH_CTX}`],
  [/^@sanoma-ai\/app(\/|$)/, "the app starts runs and decides approvals, so a workflow could approve itself"],
  [/^@sanoma-ai\/connector-[^/]+\/(fake|driver)(\/|$)/, `${THROUGH_CTX}; import the connector itself`],
  [/^sanoma\//, "`sanoma` has no entry points for a workflow: import its names from `sanoma` itself"],
];

/**
 * What a workflow may import from an author package, besides types: the one list,
 * `allowImportNames` of oxlint.json's `@sanoma-ai/workflows` entry (`sanoma`'s generated
 * `oxlint.json` derives its own entry from it). Everything else is
 * refused: the client, the worker and the app could start runs or approve the run's own
 * approvals, a ledger store could forge the audit record (a store keeps the first record per
 * id), and config helpers can read credentials.
 */
const WORKFLOW_IMPORTS: readonly string[] =
  restrictedImports(oxlint).find((p) => p.name === "@sanoma-ai/workflows")?.allowImportNames ?? [];

const ALLOWED_NAMES = new Set(WORKFLOW_IMPORTS);

const NOT_ALLOWED =
  `a workflow imports only ${WORKFLOW_IMPORTS.join(", ")} and types from ` +
  `${AUTHOR_PACKAGES.join(" or ")}: the rest could start runs, approve its own approvals, forge the ledger or read credentials`;

/**
 * Error classes a run must not test with `instanceof`: on a replay DBOS rethrows a serialized
 * copy, which is no instance of them, so a branch on it goes another way than the first time
 * and the run's steps fall out of step. Read the code with `errorCode(err)` instead.
 */
const ERROR_CLASSES = new Set(["DriverError", "SanomaError", "PolicyDeniedError", "RejectedError"]);

/**
 * Checks a workflow file. Imports allowed: the names in `WORKFLOW_IMPORTS` and any
 * type from `@sanoma-ai/workflows` or `sanoma`, `@sanoma-ai/connector-<vendor>`, `zod`, and relative files. With
 * `filename`, a relative import must stay inside the file's nearest `workflows/` directory, or its
 * own directory when it has none; the one file outside it a workflow may import is the company's
 * `resources/data.ts`, its collections (by real path). No
 * `instanceof` against the runtime's error classes: read `errorCode(err)`.
 *
 * In each workflow's `run` (the literal `defineWorkflow` is called with), it reports what the
 * outline cannot draw, as the worker refuses to start with (`outlineBody`): `ctx` used other
 * than called directly (passed on, aliased, destructured), a function defined in `run` that uses
 * `ctx` where the outline does not read it, `ctx` in a `finally`, a step name that is no literal
 * and two calls with one step name, and in `run` and the callbacks it reads, a `return` before
 * the end, a `throw` outside a `catch`, a `break` out of a loop and `continue`. Each message
 * names what to write instead.
 *
 * It guards against accidental non-determinism and accidental ways around the policy; it is
 * not a sandbox, and code written to get around it can.
 */
export function lintWorkflow(source: string, filename?: string): LintProblem[];
/** The same, over a file `readSource` read: the reading `describeConfig` shares with the outline. */
export function lintWorkflow(file: SourceFile): LintProblem[];
export function lintWorkflow(input: string | SourceFile, path?: string): LintProblem[] {
  const filename = typeof input === "string" ? path : input.file;
  const read = typeof input === "string" ? parsed(input, filename ?? "workflow.ts") : input;
  const { program, at } = read;
  const problems = [...read.problems];
  const root = filename === undefined ? undefined : nearestDir(filename, ["workflows"]);

  const checkSource = (node: Node) => {
    const spec: string = node.source.value;
    const refusal = whyRefused(spec, filename, root);
    if (refusal) {
      problems.push({ ...at(node.source.start), message: `import "${spec}" is not allowed in a workflow: ${refusal}` });
      return;
    }
    if (!AUTHOR_PACKAGES.includes(spec)) return;
    if (node.type === "ExportAllDeclaration") {
      problems.push({
        ...at(node.start),
        message: `export * from "${spec}" is not allowed in a workflow: it would re-export what a workflow may not import`,
      });
    }
    for (const s of node.specifiers ?? []) {
      if (s.type === "ImportNamespaceSpecifier") {
        problems.push({
          ...at(s.start),
          message: `import * from "${spec}" is not allowed in a workflow: import the names you use, so the rest stays out`,
        });
        continue;
      }
      // `import type { X }`, `import { type X }` and `export type { X }` bring in no values.
      if (
        node.importKind === "type" ||
        node.exportKind === "type" ||
        s.importKind === "type" ||
        s.exportKind === "type"
      ) {
        continue;
      }
      // What the module exports under: `imported` for an import, `local` for a re-export.
      const named = s.imported ?? s.local;
      const imported: string = s.type === "ImportDefaultSpecifier" ? "default" : (named?.name ?? named?.value);
      if (!ALLOWED_NAMES.has(imported)) {
        problems.push({ ...at(s.start), message: `${imported} is not allowed in a workflow: ${NOT_ALLOWED}` });
      }
    }
  };

  const visit = (node: Node) => {
    if (!node) return;
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      node.source
    ) {
      checkSource(node);
    } else if (node.type === "ImportExpression") {
      problems.push({ ...at(node.start), message: "dynamic import is not allowed in a workflow" });
    } else if (node.type === "BinaryExpression" && node.operator === "instanceof") {
      checkInstanceof(node);
    }
    for (const child of childrenOf(node)) visit(child);
  };

  // A workflow imports none of these classes, so they are refused by the name they have.
  const checkInstanceof = (node: Node) => {
    const right = node.right;
    const name: string | undefined =
      right?.type === "Identifier"
        ? right.name
        : right?.type === "MemberExpression" && !right.computed
          ? right.property?.name
          : undefined;
    if (name !== undefined && ERROR_CLASSES.has(name)) {
      problems.push({
        ...at(node.start),
        message:
          `instanceof ${name} is not allowed in a workflow: on a replay DBOS rethrows a copy of the error, ` +
          "which is no instance of it, so the run would take another branch; read `errorCode(err)`",
      });
    }
  };

  visit(program);
  // Each workflow's `run` as the worker reads it when it starts: what the outline cannot draw,
  // the worker refuses to start with. One reading, so the lint and the worker agree.
  const outlined = { consts: constsOf(program), source: typeof input === "string" ? input : input.source };
  for (const { run } of workflowLiterals(program))
    for (const { start, message } of outlineBody(run, outlined).problems) problems.push({ ...at(start), message });
  return byPosition(problems);
}

/**
 * Checks a data file under `resources/`: only named imports (a connector's constructors from its
 * `…/resources` entry, and resources from other data files inside the same `resources/`
 * directory), `export const <name> = <vendor>.<type>({ … })` with literal fields and names of
 * declared resources, and `export default [ … ]`. Each message says what to write instead.
 * It is the subset `readResources` reads (`readDataFile`), without the config: whether the
 * connector, the type and the values are known is the reader's to say.
 */
export function lintResources(source: string, filename: string): LintProblem[] {
  const { program, problems, at } = parsed(source, filename);
  for (const p of readDataFile(program, filename).problems) problems.push({ ...at(p.start), message: p.message });
  return byPosition(problems);
}

/** The `paths` of oxlint.json's `no-restricted-imports` rule. */
function restrictedImports(config: typeof oxlint): RestrictedPath[] {
  // JSON types the rule's [severity, options] as an array of either.
  return config.overrides.flatMap((o) =>
    "no-restricted-imports" in o.rules
      ? (o.rules["no-restricted-imports"] as [string, { paths: RestrictedPath[] }])[1].paths
      : [],
  );
}

type RestrictedPath = { name: string; allowImportNames?: string[] };

function whyRefused(spec: string, filename: string | undefined, root: string | undefined): string | undefined {
  if (RELATIVE.test(spec)) {
    if (filename === undefined || root === undefined) return undefined;
    const target = join(dirname(filename), spec);
    if (inside(root, target)) return undefined;
    const tree = basename(root) === "workflows";
    // The collections, which a workflow names in `uses`: the one data file the runtime imports too.
    if (tree && realPath(target) === realPath(join(dirname(root), "resources", COLLECTIONS_FILE))) return undefined;
    return (
      `it reaches outside ${tree ? `${basename(root)}/` : "this directory"}, toward the config and its drivers; ${THROUGH_CTX}` +
      (tree ? "; of the files outside it, only resources/data.ts (the collections) may be imported" : "")
    );
  }
  for (const [pattern, reason] of REFUSED_PACKAGES) if (pattern.test(spec)) return reason;
  if (ALLOWED_PACKAGE.test(spec)) return undefined;
  return "import only from `sanoma` (or `@sanoma-ai/workflows`), a `@sanoma-ai/connector-*` package, zod, or a file beside this one";
}

/** A path's real path, or the path itself when it does not exist. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
