import { parseSync } from "oxc-parser";
import type { WorkflowDefinition } from "./define.ts";
import { errorMessage } from "./shared.ts";

/**
 * What a workflow's `run` calls through `ctx`, in the order it makes the calls, with the loops,
 * branches and `ctx.all` groups around them. A reading of the body's source, not a guarantee:
 * functions `run` calls that are defined elsewhere are opaque, so their calls do not show.
 */
export type Outline = { nodes: OutlineNode[] } | { error: string };

export type OutlineNode =
  /** `ctx.<vendor>.<resource>.<name>(...)`; `dynamic` when a segment is computed, which the id shows as `*`. */
  | { kind: "op"; id: string; dynamic?: true }
  /** `ctx.approval(...)`, with its title when the first argument is a string literal. */
  | { kind: "approval"; title?: string }
  | { kind: "sleep" }
  /**
   * `ctx.all(...)`: one branch per element of an array literal; otherwise `dynamic`, with the one
   * callback found in the argument (`items.map(cb)`) as the only branch, or none.
   */
  | { kind: "all"; branches: OutlineNode[][]; dynamic?: true }
  /** A loop, or a `.map` / `.forEach` / `.reduce` callback, whose body makes ctx calls. */
  | { kind: "repeat"; body: OutlineNode[] }
  /** `if`, `switch`, `?:`, `&&`, `||` or `??`: one case per arm that makes ctx calls. */
  | { kind: "branch"; cases: OutlineNode[][] };

// oxc-parser's ESTree nodes, read by shape as lint.ts does.
type Node = any;

const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);
const ITERATING = new Set(["map", "forEach", "reduce"]);
// Wrappers that leave the expression's value as it is: `ctx!.x`, `(ctx as Ctx).x`.
const TRANSPARENT = new Set(["TSNonNullExpression", "TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion"]);
// Keys that hold no code: positions and type annotations.
const SKIPPED = new Set([
  "type",
  "start",
  "end",
  "range",
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
]);

/**
 * Outlines a workflow from the source of its `run` function (`wf.run.toString()`): TypeScript or,
 * once built, JavaScript. Counts only calls on `run`'s first parameter, whatever it is named.
 * Returns `{ error }` when the source cannot be read or parsed, or `run` takes no `ctx` by name.
 */
export function outlineWorkflow(wf: WorkflowDefinition<any, any>): Outline {
  let source: string;
  try {
    source = Function.prototype.toString.call(wf.run);
  } catch (err) {
    return { error: `Cannot read the source of ${wf.name}'s run: ${errorMessage(err)}` };
  }
  const fn = parseFunction(source);
  if (typeof fn === "string") return { error: `Cannot parse ${wf.name}'s run: ${fn}` };
  const param = unwrap(fn.params[0]);
  if (param?.type !== "Identifier") {
    return { error: `${wf.name}'s run takes no ctx parameter by name, so its calls cannot be read` };
  }
  return { nodes: outlineBody(fn.body, param.name) };
}

/** The function the source holds, or why it could not be parsed. */
function parseFunction(source: string): Node | string {
  // The one expression the text holds, or the first parse error.
  const parse = (text: string): { expression?: Node; error?: string } => {
    const { program, errors } = parseSync("run.ts", text, { lang: "ts", sourceType: "module", preserveParens: false });
    return errors.length ? { error: errors[0]!.message } : { expression: (program.body[0] as Node)?.expression };
  };
  let parsed = parse(`(${source})`);
  // A method (`async run(ctx) { … }`) is no expression on its own; it is one inside an object.
  if (parsed.error !== undefined) {
    const method = parse(`({${source}})`);
    if (method.error === undefined) parsed = { expression: method.expression?.properties?.[0]?.value };
  }
  if (parsed.error !== undefined) return parsed.error;
  return FUNCTIONS.has(parsed.expression?.type) ? parsed.expression : "it is not a function";
}

function outlineBody(body: Node, ctx: string): OutlineNode[] {
  const walk = (node: Node): OutlineNode[] => {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(walk);
    switch (node.type) {
      case "CallExpression":
        return call(node);
      case "IfStatement":
        return [...walk(node.test), ...branch(ifArms(node))];
      case "ConditionalExpression":
        return [...walk(node.test), ...branch([node.consequent, node.alternate])];
      case "LogicalExpression":
        return [...walk(node.left), ...branch([node.right])];
      case "SwitchStatement":
        return [...walk(node.discriminant), ...branch(node.cases)];
      case "ForStatement":
        return [...walk(node.init), ...repeat([node.test, node.body, node.update])];
      case "ForOfStatement":
      case "ForInStatement":
        return [...walk(node.right), ...repeat([node.left, node.body])];
      case "WhileStatement":
        return repeat([node.test, node.body]);
      case "DoWhileStatement":
        return repeat([node.body, node.test]);
    }
    // A function whose own parameter is named like ctx calls something else by that name.
    if (
      FUNCTIONS.has(node.type) &&
      node.params.some((p: Node) => unwrap(p)?.type === "Identifier" && unwrap(p).name === ctx)
    ) {
      return [];
    }
    return Object.entries(node).flatMap(([key, child]) => (SKIPPED.has(key) ? [] : walk(child)));
  };

  const branch = (arms: Node[]): OutlineNode[] => {
    const cases = arms.map(walk).filter((c) => c.length > 0);
    return cases.length ? [{ kind: "branch", cases }] : [];
  };

  const repeat = (parts: Node[]): OutlineNode[] => {
    const inside = walk(parts);
    return inside.length ? [{ kind: "repeat", body: inside }] : [];
  };

  // The arguments are evaluated before the call is made, so their calls come first.
  const call = (node: Node): OutlineNode[] => {
    const args: Node[] = node.arguments;
    const target = ctxPath(node.callee, ctx);
    if (target) {
      const { path, dynamic } = target;
      if (path.length === 1 && path[0] === "all") return all(args[0]);
      const before = walk(args);
      if (path.length === 1 && path[0] === "approval") {
        const title = stringValue(args[0]);
        return [...before, title === undefined ? { kind: "approval" } : { kind: "approval", title }];
      }
      if (path.length === 1 && path[0] === "sleep") return [...before, { kind: "sleep" }];
      if (path.length === 3) {
        const id = path.join(".");
        return [...before, dynamic ? { kind: "op", id, dynamic: true } : { kind: "op", id }];
      }
      return before;
    }
    const callee = unwrap(node.callee);
    const [callback, ...rest] = args;
    if (callee?.type === "MemberExpression" && !callee.computed && ITERATING.has(callee.property.name)) {
      if (FUNCTIONS.has(callback?.type)) return [...walk(callee.object), ...walk(rest), ...repeat([callback.body])];
    }
    return [...walk(node.callee), ...walk(args)];
  };

  const all = (arg: Node): OutlineNode[] => {
    if (arg?.type === "ArrayExpression") return [{ kind: "all", branches: arg.elements.map(walk) }];
    // Otherwise the members are computed, typically `items.map((item) => () => ctx.…)`.
    const made = unwrap(arg);
    const callback =
      made?.type === "CallExpression" ? made.arguments.find((a: Node) => FUNCTIONS.has(a?.type)) : undefined;
    if (!callback) return [...walk(arg), { kind: "all", branches: [], dynamic: true }];
    return [...walk(made.callee), { kind: "all", branches: [walk(callback.body)], dynamic: true }];
  };

  return walk(body);
}

/** `if (a) … else if (b) … else …` as its arms, the `else if` tests included in theirs. */
function ifArms(node: Node): Node[] {
  const arms: Node[] = [node.consequent];
  let rest = node.alternate;
  while (rest?.type === "IfStatement") {
    arms.push([rest.test, rest.consequent]);
    rest = rest.alternate;
  }
  if (rest) arms.push(rest);
  return arms;
}

/** The member names from `ctx` to the callee, `*` for a computed one, when the callee is on `ctx`. */
function ctxPath(callee: Node, ctx: string): { path: string[]; dynamic: boolean } | undefined {
  const path: string[] = [];
  let dynamic = false;
  let node = unwrap(callee);
  while (node?.type === "MemberExpression") {
    const name = node.computed ? stringValue(node.property) : node.property.name;
    if (name === undefined) dynamic = true;
    path.unshift(name ?? "*");
    node = unwrap(node.object);
  }
  return node?.type === "Identifier" && node.name === ctx ? { path, dynamic } : undefined;
}

/** A string literal's value, or a template literal's with nothing interpolated. */
function stringValue(node: Node): string | undefined {
  const n = unwrap(node);
  if (n?.type === "Literal" && typeof n.value === "string") return n.value;
  if (n?.type === "TemplateLiteral" && n.expressions.length === 0) return n.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

function unwrap(node: Node): Node {
  let n = node;
  while (n && (TRANSPARENT.has(n.type) || n.type === "ChainExpression" || n.type === "AssignmentPattern")) {
    n = n.type === "AssignmentPattern" ? n.left : n.expression;
  }
  return n;
}
