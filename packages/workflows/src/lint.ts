import { basename, dirname, join } from "node:path";
import { byPosition, childrenOf, type LintProblem, type Node, parsed } from "./ast.ts";
import { readDataFile } from "./datafile.ts";
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

const ALLOWED_PACKAGE = /^(@sanoma\/workflows|@sanoma\/connector-[a-z0-9-]+|zod)$/;

/** Packages refused by name, with the reason. */
const REFUSED_PACKAGES: [RegExp, string][] = [
  [/^@sanoma\/testing(\/|$)/, `fakes and test helpers belong in tests; ${THROUGH_CTX}`],
  [/^@sanoma\/app(\/|$)/, "the app starts runs and decides approvals, so a workflow could approve itself"],
  [/^@sanoma\/connector-[^/]+\/(fake|driver)(\/|$)/, `${THROUGH_CTX}; import the connector itself`],
];

/**
 * What a workflow or policy may import from `@sanoma/workflows`, besides types: oxlint.json's
 * `allowImportNames`. Everything else is refused: the client, the worker and the app could start
 * runs or approve the run's own approvals, a ledger store could forge the audit record (a store
 * keeps the first record per id), and config helpers can read credentials.
 */
const WORKFLOW_IMPORTS: readonly string[] =
  restrictedImports(oxlint).find((p) => p.name === "@sanoma/workflows")?.allowImportNames ?? [];

const ALLOWED_NAMES = new Set(WORKFLOW_IMPORTS);

const NOT_ALLOWED =
  "a workflow or policy imports only " +
  WORKFLOW_IMPORTS.join(", ") +
  " and types from @sanoma/workflows: the rest could start runs, approve its own approvals, forge the ledger or read credentials";

/**
 * Error classes a run must not test with `instanceof`: on a replay DBOS rethrows a serialized
 * copy, which is no instance of them, so a branch on it goes another way than the first time
 * and the run's steps fall out of step. Read the code with `errorCode(err)` instead.
 */
const ERROR_CLASSES = new Set(["DriverError", "SanomaError", "PolicyDeniedError", "RejectedError"]);

/**
 * Checks a workflow or policy file. Imports allowed: the names in `WORKFLOW_IMPORTS` and any
 * type from `@sanoma/workflows`, `@sanoma/connector-<vendor>`, `zod`, and relative files. With
 * `filename`, a relative import must stay inside the file's nearest `workflows/` or `policies/`
 * directory, or its own directory when it has neither. No `instanceof` against the runtime's
 * error classes: read `errorCode(err)`.
 *
 * It guards against accidental non-determinism and accidental ways around the policy; it is
 * not a sandbox, and code written to get around it can.
 */
export function lintWorkflow(source: string, filename?: string): LintProblem[] {
  const { program, problems, at } = parsed(source, filename ?? "workflow.ts");
  const root = filename === undefined ? undefined : nearestDir(filename, ["workflows", "policies"]);

  const checkSource = (node: Node) => {
    const spec: string = node.source.value;
    const refusal = whyRefused(spec, filename, root);
    if (refusal) {
      problems.push({ ...at(node.source.start), message: `import "${spec}" is not allowed in a workflow: ${refusal}` });
      return;
    }
    if (spec !== "@sanoma/workflows") return;
    if (node.type === "ExportAllDeclaration") {
      problems.push({
        ...at(node.start),
        message: `export * from "@sanoma/workflows" is not allowed in a workflow: it would re-export SanomaClient`,
      });
    }
    for (const s of node.specifiers ?? []) {
      if (s.type === "ImportNamespaceSpecifier") {
        problems.push({
          ...at(s.start),
          message: `import * from "@sanoma/workflows" is not allowed in a workflow: import the names you use, so SanomaClient stays out`,
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
    if (filename === undefined || root === undefined || inside(root, join(dirname(filename), spec))) return undefined;
    const where =
      basename(root) === "workflows" || basename(root) === "policies" ? `${basename(root)}/` : "this directory";
    return `it reaches outside ${where}, toward the config and its drivers; ${THROUGH_CTX}`;
  }
  for (const [pattern, reason] of REFUSED_PACKAGES) if (pattern.test(spec)) return reason;
  if (ALLOWED_PACKAGE.test(spec)) return undefined;
  return "import only from `@sanoma/workflows`, a `@sanoma/connector-*` package, zod, or a file beside this one";
}
