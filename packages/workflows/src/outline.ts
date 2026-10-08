import { childrenOf, type Node, parse } from "./ast.ts";
import type { WorkflowDefinition } from "./define.ts";
import { errorMessage } from "./shared.ts";

/**
 * What a workflow's `run` calls through `ctx`, in the order it makes the calls, with the loops,
 * branches and `ctx.all` groups around them. A reading of the body's source, not a guarantee:
 * the functions `run` calls are opaque, whether defined outside it or inside it, so their calls
 * do not show.
 */
export type Outline = { nodes: OutlineNode[] } | { error: string };

export type OutlineNode =
  /** `ctx.<vendor>.<resource>.<name>(...)`, a computed segment shown as `*`. */
  | { kind: "op"; id: string }
  /** `ctx.approval(...)`, with its title when the first argument is a string literal. */
  | { kind: "approval"; title?: string }
  | { kind: "sleep" }
  /** `ctx.all([...])` over an array literal: one branch per element. */
  | { kind: "all"; branches: OutlineNode[][] }
  /** `ctx.all(...)` over computed members (`items.map(cb)`): what the callback's member does, if one is found. */
  | { kind: "each"; body: OutlineNode[] }
  /** A loop, or a `.map` / `.forEach` / `.reduce` callback, whose body makes ctx calls. */
  | { kind: "repeat"; body: OutlineNode[] }
  /**
   * `if`, `switch`, `?:`, `&&`, `||` or `??`: one case per arm that makes ctx calls, and one empty
   * case for the way past them when there is one (an arm without calls, an `if` without `else`,
   * a `switch` without `default`, the right side of `&&` not run).
   */
  | { kind: "branch"; cases: OutlineNode[][] };

const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);
const ITERATING = new Set(["map", "forEach", "reduce"]);
// Wrappers that leave the expression's value as it is: `ctx!.x`, `(ctx as Ctx).x`, `ctx?.x`.
const TRANSPARENT = new Set([
  "TSNonNullExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "ChainExpression",
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

/** The one expression the text holds, or the first parse error. */
function expression(text: string): Node | string {
  const { program, errors } = parse("run.ts", text);
  return errors.length ? errors[0]!.message : (program.body[0] as Node)?.expression;
}

/** The function the source holds, or why it could not be parsed. */
function parseFunction(source: string): Node | string {
  let parsed = expression(`(${source})`);
  // A method (`async run(ctx) { … }`) is no expression on its own; it is one inside an object.
  if (typeof parsed === "string") {
    const method = expression(`({${source}})`);
    if (typeof method !== "string") parsed = method?.properties?.[0]?.value;
  }
  if (typeof parsed === "string") return parsed;
  return FUNCTIONS.has(parsed?.type) ? parsed : "it is not a function";
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
        // The right side may not run: the way past it is an arm with no calls.
        return [...walk(node.left), ...branch([node.right, null])];
      case "SwitchStatement":
        return [...walk(node.discriminant), ...branch(switchArms(node))];
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
    // A function's body runs when the function is called, wherever and however often that is,
    // which a reading of the source cannot follow. Only the callbacks of ctx.all and of `.map`,
    // `.forEach` and `.reduce` are read, where they are passed.
    if (FUNCTIONS.has(node.type)) return [];
    return childrenOf(node).flatMap(walk);
  };

  // The arms that make calls, and one empty arm when some arm makes none: the way past them.
  const branch = (arms: Node[]): OutlineNode[] => {
    const walked = arms.map(walk);
    const cases = walked.filter((c) => c.length > 0);
    if (!cases.length) return [];
    if (cases.length < walked.length) cases.push([]);
    return [{ kind: "branch", cases }];
  };

  const repeat = (parts: Node[]): OutlineNode[] => {
    const inside = walk(parts);
    return inside.length ? [{ kind: "repeat", body: inside }] : [];
  };

  // The arguments are evaluated before the call is made, so their calls come first.
  const call = (node: Node): OutlineNode[] => {
    const args: Node[] = node.arguments;
    const path = ctxPath(node.callee, ctx);
    if (path) {
      const id = path.join(".");
      switch (id) {
        case "all":
          return all(args[0]);
        case "approval": {
          const title = stringValue(args[0]);
          return [...walk(args), title === undefined ? { kind: "approval" } : { kind: "approval", title }];
        }
        case "sleep":
          return [...walk(args), { kind: "sleep" }];
        default:
          return path.length === 3 ? [...walk(args), { kind: "op", id }] : walk(args);
      }
    }
    const callee = unwrap(node.callee);
    const [callback, ...rest] = args;
    if (callee?.type === "MemberExpression" && !callee.computed && ITERATING.has(callee.property.name)) {
      if (FUNCTIONS.has(callback?.type)) return [...walk(callee.object), ...walk(rest), ...repeat([callback.body])];
    }
    return [...walk(node.callee), ...walk(args)];
  };

  const all = (arg: Node): OutlineNode[] => {
    if (arg?.type === "ArrayExpression") return [{ kind: "all", branches: arg.elements.map(member) }];
    // Otherwise the members are computed, typically `items.map((item) => () => ctx.…)`.
    const made = unwrap(arg);
    const callback =
      made?.type === "CallExpression" ? made.arguments.find((a: Node) => FUNCTIONS.has(a?.type)) : undefined;
    if (!callback) return [...walk(arg), { kind: "each", body: [] }];
    return [...walk(made.callee), { kind: "each", body: member(callback.body) }];
  };

  // What a member does: a function's body, read where the function is passed, or else the calls
  // the expression makes.
  const member = (node: Node): OutlineNode[] => {
    const fn = unwrap(node);
    return FUNCTIONS.has(fn?.type) ? walk(fn.body) : walk(node);
  };

  return walk(body);
}

/**
 * `if (a) … else if (b) … else …` as its arms, the `else if` tests included in theirs. With no
 * final `else`, the last arm is `null`: an arm with no calls, the way past the others.
 */
function ifArms(node: Node): Node[] {
  const arms: Node[] = [node.consequent];
  let rest = node.alternate;
  while (rest?.type === "IfStatement") {
    arms.push([rest.test, rest.consequent]);
    rest = rest.alternate;
  }
  arms.push(rest);
  return arms;
}

/**
 * A `switch`'s arms: each case with statements (an empty one falls into the next), and with no
 * `default`, `null` for the way past them.
 */
function switchArms(node: Node): Node[] {
  const arms: Node[] = node.cases.filter((c: Node) => c.consequent.length > 0);
  return node.cases.some((c: Node) => c.test === null) ? arms : [...arms, null];
}

/** The member names from `ctx` to the callee, `*` for a computed one, when the callee is on `ctx`. */
function ctxPath(callee: Node, ctx: string): string[] | undefined {
  const path: string[] = [];
  let node = unwrap(callee);
  while (node?.type === "MemberExpression") {
    path.unshift((node.computed ? stringValue(node.property) : node.property.name) ?? "*");
    node = unwrap(node.object);
  }
  return node?.type === "Identifier" && node.name === ctx ? path : undefined;
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
  while (n && (TRANSPARENT.has(n.type) || n.type === "AssignmentPattern")) {
    n = n.type === "AssignmentPattern" ? n.left : n.expression;
  }
  return n;
}
