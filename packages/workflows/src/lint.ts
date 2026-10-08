import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { parseSync } from "oxc-parser";

export interface LintProblem {
  line: number;
  column: number;
  message: string;
}

/**
 * A workflow must call vendors through `ctx`, so the policy sees every call. These are the
 * import rules oxlint's built-in rules cannot express; the clock, randomness, the network
 * and the environment are oxlint's (`@sanoma/workflows/oxlint`).
 */
const THROUGH_CTX = "a workflow must call vendors through ctx, so the policy sees every call";

const ALLOWED_PACKAGE = /^(@sanoma\/workflows|@sanoma\/connector-[a-z0-9-]+|zod)$/;
const RELATIVE = /^\.\.?\//;

/** Packages refused by name, with the reason. */
const REFUSED_PACKAGES: [RegExp, string][] = [
  [/^@sanoma\/testing(\/|$)/, `fakes and test helpers belong in tests; ${THROUGH_CTX}`],
  [/^@sanoma\/app(\/|$)/, "the app starts runs and decides approvals, so a workflow could approve itself"],
  [/^@sanoma\/connector-[^/]+\/(fake|driver)(\/|$)/, `${THROUGH_CTX}; import the connector itself`],
];

/**
 * What a workflow or policy may import from `@sanoma/workflows`, besides types. Everything else
 * is refused: the client, the worker and the app could start runs or approve the run's own
 * approvals, a ledger store could forge the audit record (a store keeps the first record per
 * id), and config helpers can read credentials. Kept equal to `allowImportNames` in oxlint.json.
 */
export const WORKFLOW_IMPORTS = [
  "defineWorkflow",
  "definePolicy",
  "allow",
  "deny",
  "approve",
  "approvedFor",
  "allowAll",
  "mayDecide",
  "errorCode",
  "DriverError",
] as const;

const ALLOWED_NAMES = new Set<string>(WORKFLOW_IMPORTS);

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
  const { program, errors } = parseSync(filename ?? "workflow.ts", source, { sourceType: "module", lang: "ts" });
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const at = (offset: number) => {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= offset) line++;
    return { line: line + 1, column: offset - lineStarts[line]! + 1 };
  };
  const problems: LintProblem[] = errors.map((e) => ({
    ...at(e.labels?.[0]?.start ?? 0),
    message: `syntax: ${e.message}`,
  }));
  const root = filename === undefined ? undefined : treeOf(filename);
  // Local names of the runtime's error classes, as imported, and every `instanceof` seen.
  const errorClasses = new Set<string>();
  const instanceofs: any[] = [];

  const checkSource = (node: any) => {
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
      } else if (ERROR_CLASSES.has(imported) && s.local?.name) errorClasses.add(s.local.name);
    }
  };

  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
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
      instanceofs.push(node);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "type" && key !== "start" && key !== "end" && child && typeof child === "object") visit(child);
    }
  };

  visit(program);
  // After the walk, so an import below its use still counts.
  for (const node of instanceofs) {
    const right = node.right;
    const name: string | undefined =
      right?.type === "Identifier"
        ? right.name
        : right?.type === "MemberExpression" && !right.computed
          ? right.property?.name
          : undefined;
    if (name !== undefined && (errorClasses.has(name) || ERROR_CLASSES.has(name))) {
      problems.push({
        ...at(node.start),
        message:
          `instanceof ${name} is not allowed in a workflow: on a replay DBOS rethrows a copy of the error, ` +
          "which is no instance of it, so the run would take another branch; read `errorCode(err)`",
      });
    }
  }
  return problems.toSorted((a, b) => a.line - b.line || a.column - b.column);
}

function whyRefused(spec: string, filename: string | undefined, root: string | undefined): string | undefined {
  if (RELATIVE.test(spec)) {
    if (filename === undefined || root === undefined) return undefined;
    const rel = relative(root, join(dirname(filename), spec));
    if (rel !== "" && rel.split(sep)[0] !== ".." && !isAbsolute(rel)) return undefined;
    const where =
      basename(root) === "workflows" || basename(root) === "policies" ? `${basename(root)}/` : "this directory";
    return `it reaches outside ${where}, toward the config and its drivers; ${THROUGH_CTX}`;
  }
  for (const [pattern, reason] of REFUSED_PACKAGES) if (pattern.test(spec)) return reason;
  if (ALLOWED_PACKAGE.test(spec)) return undefined;
  return "import only from `@sanoma/workflows`, a `@sanoma/connector-*` package, zod, or a file beside this one";
}

/** The file's nearest `workflows/` or `policies/` ancestor directory, else its own directory. */
function treeOf(filename: string): string {
  for (let dir = dirname(filename); ; dir = dirname(dir)) {
    const name = basename(dir);
    if (name === "workflows" || name === "policies") return dir;
    if (dirname(dir) === dir) return dirname(filename);
  }
}
