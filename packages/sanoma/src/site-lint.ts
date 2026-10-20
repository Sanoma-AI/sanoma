import { basename, dirname, relative, resolve, sep } from "node:path";

// The oxlint rule `sanoma/site-file`: what the generated `oxlint.json`'s `sites/**` override cannot
// say with oxlint's own rules. A site is client code with no server of its own: no `*.server.*`
// file, no server function or middleware, no `server` handlers on a route, and no relative import
// out of `sites/`. Typed here by the little it uses, so the package needs no oxlint types.

/** An ESTree node, by the little this rule reads of it. */
interface AstNode {
  type: string;
  range: [number, number];
  [field: string]: any;
}
interface RuleContext {
  filename: string;
  report(diagnostic: { message: string; node: Pick<AstNode, "range"> }): void;
}

const REMEDY = "call an operation or start a workflow through `api` from `sanoma/site`.";

/** The server-side builders TanStack Start exports; a site has no server code. */
const SERVER_CALLS = new Set(["createServerFn", "createServerOnlyFn", "createMiddleware"]);

/** A callee's name: `f` for `f(…)` and `x.f(…)`. */
const calleeName = (callee: AstNode): string | undefined =>
  callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" ? callee.property.name : undefined;

/** The nearest directory above `file` named `sites`. */
function sitesOf(file: string): string | undefined {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    if (basename(dir) === "sites") return dir;
  }
  return undefined;
}

export const siteFile = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A file under sites/ is client code: no *.server.* file, server function, middleware, route `server` handlers or relative import out of sites/",
    },
  },
  create(context: RuleContext) {
    const sites = sitesOf(context.filename);
    /** A relative import that resolves outside `sites/`. */
    const leaves = (source: unknown): boolean => {
      if (typeof source !== "string" || !source.startsWith(".") || sites === undefined) return false;
      const to = relative(sites, resolve(dirname(context.filename), source));
      return to === ".." || to.startsWith(`..${sep}`);
    };
    const imported = (node: AstNode) => {
      if (node.source && leaves(node.source.value)) {
        context.report({
          message: `A site imports only from inside sites/, \`sanoma/site\`, \`@sanoma-ai/app/ui\` and its packages: ${String(node.source.value)} leaves sites/.`,
          node: node.source,
        });
      }
    };
    return {
      Program(program: AstNode) {
        if (basename(context.filename).includes(".server.")) {
          context.report({
            message: `A site has no server code, so no *.server.* file: ${REMEDY}`,
            node: program,
          });
        }
      },
      ImportDeclaration: imported,
      ExportNamedDeclaration: imported,
      ExportAllDeclaration: imported,
      ImportExpression: imported,
      CallExpression(call: AstNode) {
        const name = calleeName(call.callee);
        if (name !== undefined && SERVER_CALLS.has(name)) {
          context.report({ message: `A site has no server code, so no ${name}: ${REMEDY}`, node: call.callee });
          return;
        }
        // createFileRoute("/path")({ server: { handlers } })
        if (call.callee.type !== "CallExpression" || calleeName(call.callee.callee) !== "createFileRoute") return;
        const server = (call.arguments[0]?.properties as AstNode[] | undefined)?.find(
          (p) => p.type === "Property" && (p.key.name ?? p.key.value) === "server",
        );
        if (server) {
          context.report({ message: `A site's route has no \`server\` handlers: ${REMEDY}`, node: server });
        }
      },
    };
  },
};
