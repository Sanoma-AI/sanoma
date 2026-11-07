// An oxlint JS plugin with one rule, on the trees oxlint has already parsed, which the package's
// `oxlint.json` turns on for `workflows/**`: `sanoma/date`, `Date` reading the clock. Typed here by
// the little it uses, so the package needs no oxlint types.

interface Context {
  filename: string;
  sourceCode: { isGlobalReference(node: Node): boolean };
  report(diagnostic: { message: string; node: { range: [number, number] } }): void;
}

/** A node of oxlint's ESTree, by the little the `date` rule reads. */
interface Node {
  type: string;
  range: [number, number];
  parent?: Node;
  name?: string;
  callee?: Node;
  object?: Node;
  property?: Node;
  computed?: boolean;
  arguments?: Node[];
  operator?: string;
  right?: Node;
}

const DATE_MESSAGE =
  "Workflows are replayed, so a workflow reads the clock with `await ctx.now()`, never `Date`: `new Date(await ctx.now())` for a date, `new Date(value)`, `Date.parse` or `Date.UTC` for one it has, and `ctx.sleep({ until })` to wait for a date.";

/** Where `Date` names the type, which the build erases: `d: Date`, `typeof Date`, `implements Date`. */
const TYPE_PARENTS = new Set([
  "TSTypeReference",
  "TSTypeQuery",
  "TSQualifiedName",
  "TSClassImplements",
  "TSInterfaceHeritage",
]);

/** `Date`'s functions that read no clock. */
const PURE = new Set(["parse", "UTC"]);

/**
 * Whether `Date` (`node`) reads no clock where it is: `new Date(value)`, `Date.parse(…)`,
 * `Date.UTC(…)`, `x instanceof Date`, or a type. A node without its parent is reported.
 */
function readsNoClock(node: Node): boolean {
  const { parent } = node;
  if (!parent) return false;
  if (TYPE_PARENTS.has(parent.type)) return true;
  if (parent.type === "BinaryExpression") return parent.operator === "instanceof" && parent.right === node;
  if (parent.type === "NewExpression" && parent.callee === node) {
    const [first] = parent.arguments ?? [];
    return first !== undefined && first.type !== "SpreadElement";
  }
  return (
    parent.type === "MemberExpression" &&
    parent.object === node &&
    !parent.computed &&
    PURE.has(parent.property?.name ?? "")
  );
}

const plugin = {
  meta: { name: "sanoma" },
  rules: {
    // `Date` reads the clock in `Date.now()`, `new Date()` and `Date()`, which a replay would read
    // again; a workflow reads it with `ctx.now()`, recorded. Every other use of `Date` is pure:
    // `new Date(value)` (of `await ctx.now()`, or of a date the workflow has), `Date.parse`, `Date.UTC`.
    date: {
      meta: {
        type: "problem",
        docs: { description: "A workflow reads the clock with `await ctx.now()`, never `Date`" },
      },
      create(context: Context) {
        return {
          Identifier(node: Node) {
            if (node.name !== "Date" || readsNoClock(node)) return;
            if (context.sourceCode.isGlobalReference(node)) context.report({ message: DATE_MESSAGE, node });
          },
        };
      },
    },
  },
};

export default plugin;
