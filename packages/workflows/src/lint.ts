import { parseSync } from "oxc-parser";

export interface LintProblem {
  line: number;
  column: number;
  message: string;
}

/**
 * Workflows are replayed by re-running the function and reading step results back,
 * so the code must do the same thing every time. Anything that reads the clock,
 * randomness, the network or the environment has to go through `ctx`.
 */
const FORBIDDEN_GLOBALS: Record<string, string> = {
  Date: "use `await ctx.now()` for the time, and `ctx.sleep({ until })` to wait for a date",
  fetch: "call the vendor through a connector operation listed in `uses`",
  setTimeout: "use `ctx.sleep`",
  setInterval: "use `ctx.sleep` in a loop",
  setImmediate: "use `ctx.sleep`",
  queueMicrotask: "await the work directly",
  process: "pass configuration as workflow input",
  performance: "use `await ctx.now()`",
  crypto: "derive ids from `ctx.runId`",
  require: "import from `@sanoma/*` or another workflow file",
  eval: "not allowed in workflows",
  Function: "not allowed in workflows",
  WebSocket: "call the vendor through a connector operation listed in `uses`",
  XMLHttpRequest: "call the vendor through a connector operation listed in `uses`",
};

const ALLOWED_IMPORT = /^(@sanoma\/|\.\.?\/|zod$)/;

/** Runtime entry points a workflow or policy could use to start runs or approve its own approvals. */
const FORBIDDEN_IMPORTS: Record<string, string> = {
  SanomaClient: "a workflow must not start runs or decide approvals",
  startWorker: "a workflow must not start a worker",
};

export function lintWorkflow(source: string, filename = "workflow.ts"): LintProblem[] {
  const { program, errors } = parseSync(filename, source, { sourceType: "module", lang: "ts" });
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
  const declared = new Set<string>();

  const visit = (node: any, parent: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, parent);
      return;
    }
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        if (node.source && !ALLOWED_IMPORT.test(node.source.value)) {
          problems.push({
            ...at(node.source.start),
            message: `import "${node.source.value}" is not allowed in a workflow; import from \`@sanoma/*\` or another workflow file`,
          });
        }
        if (node.source?.value === "@sanoma/workflows") {
          for (const spec of node.specifiers ?? []) {
            const name = spec.imported?.name ?? spec.local?.name ?? spec.imported?.value;
            if (spec.type !== "ImportDefaultSpecifier" && name in FORBIDDEN_IMPORTS) {
              problems.push({
                ...at(spec.start),
                message: `${name} is not allowed in a workflow: ${FORBIDDEN_IMPORTS[name]}`,
              });
            }
          }
        }
        break;
      case "ImportExpression":
        problems.push({ ...at(node.start), message: "dynamic import is not allowed in a workflow" });
        break;
      case "Identifier":
        if (node.name in FORBIDDEN_GLOBALS && !declared.has(node.name) && isReference(node, parent)) {
          problems.push({
            ...at(node.start),
            message: `${node.name} is not allowed in a workflow: ${FORBIDDEN_GLOBALS[node.name]}`,
          });
        }
        break;
      case "MemberExpression":
        if (
          node.object?.type === "Identifier" &&
          node.object.name === "Math" &&
          !node.computed &&
          node.property?.name === "random"
        ) {
          problems.push({
            ...at(node.start),
            message: "Math.random is not allowed in a workflow: derive values from `ctx.runId` or the input",
          });
        }
        break;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "type" && key !== "start" && key !== "end" && child && typeof child === "object") visit(child, node);
    }
  };

  collectDeclarations(program, declared);
  visit(program, null);
  return problems.toSorted((a, b) => a.line - b.line || a.column - b.column);
}

/** Names the file declares itself (so a local `process` or `crypto` is fine). */
function collectDeclarations(node: any, out: Set<string>) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((n) => collectDeclarations(n, out));
  if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") out.add(node.id.name);
  if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id) out.add(node.id.name);
  if (
    node.type === "ImportSpecifier" ||
    node.type === "ImportDefaultSpecifier" ||
    node.type === "ImportNamespaceSpecifier"
  ) {
    out.add(node.local.name);
  }
  for (const [key, child] of Object.entries(node))
    if (key !== "type" && child && typeof child === "object") collectDeclarations(child, out);
}

/** True when an identifier reads a variable, not when it names a property or key. */
function isReference(node: any, parent: any): boolean {
  if (!parent) return true;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return false;
  if (
    (parent.type === "Property" || parent.type === "ObjectProperty") &&
    parent.key === node &&
    !parent.computed &&
    !parent.shorthand
  )
    return false;
  if ((parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && parent.key === node) return false;
  if (parent.type?.startsWith("TS")) return false;
  return true;
}
