import { readDataFile } from "./datafile.ts";

// An oxlint JS plugin with two rules, on the trees oxlint has already parsed, which the package's
// `oxlint.json` turns on: `sanoma/data-file` for `resources/**`, the data-file subset
// `readResources` reads, the same check as `lintResources`; and `sanoma/date` for `workflows/**`,
// the clock. Typed here by the little they use, so the package needs no oxlint types.

interface Context {
  filename: string;
  sourceCode: { isGlobalReference(node: Node): boolean; getScope(node: Node): Scope };
  report(diagnostic: { message: string; node: { range: [number, number] } }): void;
}

/** A node of oxlint's ESTree, by the little the rules read. */
interface Node {
  type: string;
  range: [number, number];
  parent?: Node;
  [key: string]: unknown;
}

/** A scope of oxlint's scope manager, by the little the `date` rule reads. */
interface Scope {
  upper: Scope | null;
  set: Map<string, { defs: { type: string; node: Node; parent: Node | null }[] }>;
}

const DATE_MESSAGE =
  "Workflows are replayed: use `await ctx.now()` for the time, `new Date(await ctx.now())` (or of a `const` holding it) for a date, and `ctx.sleep({ until })` to wait for a date.";

/** Where `Date` names the type, which the build erases: `d: Date`, `typeof Date`, `implements Date`. */
const TYPE_PARENTS = new Set([
  "TSTypeReference",
  "TSTypeQuery",
  "TSQualifiedName",
  "TSClassImplements",
  "TSInterfaceHeritage",
]);

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

/** `await ctx.now()`. */
const isNow = (node: Node): boolean => {
  if (node.type !== "AwaitExpression" || !isNode(node.argument)) return false;
  const call = node.argument;
  if (call.type !== "CallExpression" || (call.arguments as unknown[]).length > 0 || !isNode(call.callee)) return false;
  const { callee } = call;
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    isNode(callee.object) &&
    callee.object.type === "Identifier" &&
    callee.object.name === "ctx" &&
    isNode(callee.property) &&
    callee.property.name === "now"
  );
};

/**
 * Whether `node` reads `await ctx.now()` as it is evaluated, not inside a function it defines,
 * itself or through a `const` initialised so (`const now = await ctx.now()`), which
 * `isConstNow` says of an identifier.
 */
const readsNow = (node: Node, isConstNow: (id: Node) => boolean): boolean =>
  isNow(node) ||
  (node.type === "Identifier" && isConstNow(node)) ||
  (!/Function/.test(node.type) &&
    Object.entries(node).some(
      ([key, value]) =>
        key !== "parent" &&
        (Array.isArray(value)
          ? value.some((v) => isNode(v) && readsNow(v, isConstNow))
          : isNode(value) && readsNow(value, isConstNow)),
    ));

/** For `readsNow`: whether `id` names a `const` whose initialiser reads `await ctx.now()`. */
function constNow(context: Context, seen = new Set<Node>()) {
  return (id: Node): boolean => {
    for (let scope: Scope | null = context.sourceCode.getScope(id); scope; scope = scope.upper) {
      const variable = scope.set.get(id.name as string);
      if (!variable) continue;
      const [def, ...more] = variable.defs;
      const init = def?.node.init;
      if (more.length || def?.type !== "Variable" || def.parent?.kind !== "const" || !isNode(init)) return false;
      if (seen.has(init)) return false;
      seen.add(init);
      return readsNow(init, constNow(context, seen));
    }
    return false;
  };
}

const plugin = {
  meta: { name: "sanoma" },
  rules: {
    "data-file": {
      meta: {
        type: "problem",
        docs: {
          description:
            "A data file under resources/ holds only imports, `export const <name> = <vendor>.<type>({ … })` with literal fields, and `export default [ … ]`; resources/data.ts holds only collections, `collection({ … })` from sanoma/data",
        },
      },
      create(context: Context) {
        return {
          Program(program: unknown) {
            for (const { start, end, message } of readDataFile(program, context.filename).problems) {
              context.report({ message, node: { range: [start, end] } });
            }
          },
        };
      },
    },
    // A workflow reads the time from `ctx.now()`, which a replay reads back as it was. `Date`
    // itself is refused, but for `new Date(…)` of a value read from `await ctx.now()`, in its
    // argument or a `const` it names: a date as ISO text (`.toISOString()`), the same on every replay.
    date: {
      meta: {
        type: "problem",
        docs: {
          description: "A workflow reads the time from `await ctx.now()`: `Date` only as `new Date(await ctx.now())`",
        },
      },
      create(context: Context) {
        return {
          Identifier(node: Node) {
            const { parent } = node;
            if (node.name !== "Date" || TYPE_PARENTS.has(parent?.type ?? "")) return;
            if (!context.sourceCode.isGlobalReference(node)) return;
            const stamp =
              parent?.type === "NewExpression" &&
              parent.callee === node &&
              (parent.arguments as Node[]).length === 1 &&
              readsNow((parent.arguments as Node[])[0]!, constNow(context));
            if (!stamp) context.report({ message: DATE_MESSAGE, node });
          },
        };
      },
    },
  },
};

export default plugin;
