import { readFileSync } from "node:fs";
import { childrenOf, type Node, parse } from "./ast.ts";
import type { WorkflowDefinition } from "./define.ts";
import { errorMessage } from "./shared.ts";

/**
 * What a workflow's `run` calls through `ctx`, in the order it makes the calls, with the loops,
 * branches and `ctx.all` groups around them. A reading of the body's source, not a guarantee:
 * the functions `run` calls are opaque, whether defined outside it or inside it, so their calls
 * do not show.
 */
export type Outline =
  /** Read from the file that defined the workflow (`wf.file`): the spans index into its text. */
  | { nodes: OutlineNode[]; file: string }
  /** Read from `run`'s own text (`run.toString()`), which the spans index into; `fallback` says why the file was not. */
  | { nodes: OutlineNode[]; fallback: string }
  | { error: string };

/** Where a node is in the text the outline was read from: UTF-16 offsets, as a string index or CodeMirror counts them. */
export type Span = readonly [start: number, end: number];

/**
 * Each node's `span` is the code it stands for: the call for `op`, `approval` and `sleep`, the
 * `ctx.all(...)` call for `all` and `each`, the loop or the iterating call (`items.map(cb)`) for
 * `repeat`, and the whole `if` / `else if` chain, `switch`, `?:` or `&&` for `branch`.
 */
export type OutlineNode = { span: Span } &
  /** `ctx.<vendor>.<resource>.<name>(...)`, a computed segment shown as `*`. */
  (
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
    | { kind: "branch"; cases: OutlineNode[][] }
  );

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
 * Outlines a workflow from the source of its `run` function: TypeScript or, once built,
 * JavaScript. It reads the file that defined it (`wf.file`) when that can be read and holds it,
 * else `run`'s own text (`wf.run.toString()`), and says which. Counts only calls on `run`'s
 * first parameter, whatever it is named. Returns `{ error }` when `run`'s text cannot be read or
 * parsed, or `run` takes no `ctx` by name.
 */
export const outlineWorkflow = (wf: WorkflowDefinition<any, any>): Outline => outlineWithSource(wf).outline;

/**
 * `outlineWorkflow`, with the text its spans index into: the file's, or `run`'s, with `\n`
 * line endings either way. No text with an `{ error }`.
 */
export function outlineWithSource(wf: WorkflowDefinition<any, any>): { outline: Outline; source?: string } {
  const read = wf.file === undefined ? `${wf.name} has no file` : inFile(wf.file, wf.name);
  const found = typeof read === "string" ? inRun(wf) : read;
  if (typeof found === "string") return { outline: { error: found } };
  const { source, fn, offset } = found;
  const param = unwrap(fn.params[0]);
  if (param?.type !== "Identifier") {
    return { outline: { error: `${wf.name}'s run takes no ctx parameter by name, so its calls cannot be read` } };
  }
  const nodes = outlineBody(fn.body, param.name, offset);
  return { source, outline: typeof read === "string" ? { nodes, fallback: read } : { nodes, file: wf.file! } };
}

/** CodeMirror counts a line break as one unit, oxc counts `\r\n` as two: spans need `\n` alone. */
const lf = (text: string) => text.replaceAll("\r\n", "\n");

interface Found {
  source: string;
  fn: Node;
  /** What to take off a node's offsets to index into `source`. */
  offset: number;
}

/**
 * The workflow's `run` in its file: the first object literal with its `name` and a `run`
 * function. Or why not: the file cannot be read or parsed, or holds no such literal.
 */
function inFile(file: string, name: string): Found | string {
  let source: string;
  try {
    source = lf(readFileSync(file, "utf8"));
  } catch (err) {
    return `${file} could not be read: ${errorMessage(err)}`;
  }
  const { program, errors } = parse(file, source);
  if (errors.length) return `${file} could not be parsed: ${errors[0]!.message}`;
  const find = (node: Node): Node | undefined => {
    if (!node) return undefined;
    if (node.type === "ObjectExpression") {
      const value = (key: string) =>
        node.properties.find((p: Node) => p.type === "Property" && !p.computed && (p.key.name ?? p.key.value) === key)
          ?.value;
      const run = value("run");
      if (stringValue(value("name")) === name && FUNCTIONS.has(run?.type)) return run;
    }
    for (const child of childrenOf(node)) {
      const fn = find(child);
      if (fn) return fn;
    }
    return undefined;
  };
  const fn = find(program);
  return fn ? { source, fn, offset: 0 } : `${file} holds no workflow named "${name}"`;
}

/** `run`'s own text, parsed, or why it could not be read or parsed. */
function inRun(wf: WorkflowDefinition<any, any>): Found | string {
  let source: string;
  try {
    source = lf(Function.prototype.toString.call(wf.run));
  } catch (err) {
    return `Cannot read the source of ${wf.name}'s run: ${errorMessage(err)}`;
  }
  const parsed = parseFunction(source);
  return typeof parsed === "string" ? `Cannot parse ${wf.name}'s run: ${parsed}` : { source, ...parsed };
}

/** The one expression the text holds, or the first parse error. */
function expression(text: string): Node | string {
  const { program, errors } = parse("run.ts", text);
  return errors.length ? errors[0]!.message : (program.body[0] as Node)?.expression;
}

/**
 * What `run`'s text is parsed inside, in turn: as an expression, then, for a method
 * (`async run(ctx) { … }`), which is no expression on its own, as one inside an object.
 */
const PREFIXES = [
  ["(", ")"],
  ["({", "})"],
] as const;

/** The function the source holds and the length of the wrapper parsed around it, or why it could not be parsed. */
function parseFunction(source: string): Omit<Found, "source"> | string {
  let error = "";
  for (const [prefix, suffix] of PREFIXES) {
    const parsed = expression(prefix + source + suffix);
    if (typeof parsed === "string") {
      error ||= parsed;
      continue;
    }
    const fn = prefix === "({" ? parsed?.properties?.[0]?.value : parsed;
    return FUNCTIONS.has(fn?.type) ? { fn, offset: prefix.length } : "it is not a function";
  }
  return error;
}

function outlineBody(body: Node, ctx: string, offset: number): OutlineNode[] {
  const span = (node: Node): Span => [node.start - offset, node.end - offset];

  const walk = (node: Node): OutlineNode[] => {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(walk);
    switch (node.type) {
      case "CallExpression":
        return call(node);
      case "IfStatement":
        return [...walk(node.test), ...branch(node, ifArms(node))];
      case "ConditionalExpression":
        return [...walk(node.test), ...branch(node, [node.consequent, node.alternate])];
      case "LogicalExpression":
        // The right side may not run: the way past it is an arm with no calls.
        return [...walk(node.left), ...branch(node, [node.right, null])];
      case "SwitchStatement":
        return [...walk(node.discriminant), ...branch(node, switchArms(node))];
      case "ForStatement":
        return [...walk(node.init), ...repeat(node, [node.test, node.body, node.update])];
      case "ForOfStatement":
      case "ForInStatement":
        return [...walk(node.right), ...repeat(node, [node.left, node.body])];
      case "WhileStatement":
        return repeat(node, [node.test, node.body]);
      case "DoWhileStatement":
        return repeat(node, [node.body, node.test]);
    }
    // A function's body runs when the function is called, wherever and however often that is,
    // which a reading of the source cannot follow. Only the callbacks of ctx.all and of `.map`,
    // `.forEach` and `.reduce` are read, where they are passed.
    if (FUNCTIONS.has(node.type)) return [];
    return childrenOf(node).flatMap(walk);
  };

  // The arms that make calls, and one empty arm when some arm makes none: the way past them.
  const branch = (node: Node, arms: Node[]): OutlineNode[] => {
    const walked = arms.map(walk);
    const cases = walked.filter((c) => c.length > 0);
    if (!cases.length) return [];
    if (cases.length < walked.length) cases.push([]);
    return [{ kind: "branch", cases, span: span(node) }];
  };

  const repeat = (node: Node, parts: Node[]): OutlineNode[] => {
    const inside = walk(parts);
    return inside.length ? [{ kind: "repeat", body: inside, span: span(node) }] : [];
  };

  // The arguments are evaluated before the call is made, so their calls come first.
  const call = (node: Node): OutlineNode[] => {
    const args: Node[] = node.arguments;
    const path = ctxPath(node.callee, ctx);
    if (path) {
      const id = path.join(".");
      switch (id) {
        case "all":
          return all(node);
        case "approval": {
          const title = stringValue(args[0]);
          return [...walk(args), { kind: "approval", span: span(node), ...(title === undefined ? {} : { title }) }];
        }
        case "sleep":
          return [...walk(args), { kind: "sleep", span: span(node) }];
        default:
          return path.length === 3 ? [...walk(args), { kind: "op", id, span: span(node) }] : walk(args);
      }
    }
    const callee = unwrap(node.callee);
    const [callback, ...rest] = args;
    if (callee?.type === "MemberExpression" && !callee.computed && ITERATING.has(callee.property.name)) {
      if (FUNCTIONS.has(callback?.type)) {
        return [...walk(callee.object), ...walk(rest), ...repeat(node, [callback.body])];
      }
    }
    return [...walk(node.callee), ...walk(args)];
  };

  // `node` is the `ctx.all(...)` call.
  const all = (node: Node): OutlineNode[] => {
    const at = span(node);
    const arg = node.arguments[0];
    if (arg?.type === "ArrayExpression") return [{ kind: "all", branches: arg.elements.map(member), span: at }];
    // Otherwise the members are computed, typically `items.map((item) => () => ctx.…)`.
    const made = unwrap(arg);
    const callback =
      made?.type === "CallExpression" ? made.arguments.find((a: Node) => FUNCTIONS.has(a?.type)) : undefined;
    if (!callback) return [...walk(arg), { kind: "each", body: [], span: at }];
    return [...walk(made.callee), { kind: "each", body: member(callback.body), span: at }];
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
