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

/** Runtime entry points a workflow or policy could use to start runs or approve its own approvals. */
const FORBIDDEN_IMPORTS: Record<string, string> = {
  SanomaClient: "a workflow must not start runs or decide approvals (it could approve itself); ask with `ctx.approval`",
  startWorker: "a workflow must not start a worker; it already runs inside one",
  startApp: "a workflow must not start the app, which decides approvals; ask with `ctx.approval`",
};

/**
 * Checks a workflow or policy file's imports. Allowed: `@sanoma/workflows` (without
 * `SanomaClient`, `startWorker` or `startApp`), `@sanoma/connector-<vendor>`, `zod`, and
 * relative files. With `filename`, a relative import must stay inside the file's nearest
 * `workflows/` or `policies/` directory, or its own directory when it has neither.
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
      const name = s.imported?.name ?? s.imported?.value ?? s.local?.name ?? s.local?.value;
      if (s.type !== "ImportDefaultSpecifier" && Object.hasOwn(FORBIDDEN_IMPORTS, name)) {
        problems.push({ ...at(s.start), message: `${name} is not allowed in a workflow: ${FORBIDDEN_IMPORTS[name]}` });
      }
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
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "type" && key !== "start" && key !== "end" && child && typeof child === "object") visit(child);
    }
  };

  visit(program);
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
