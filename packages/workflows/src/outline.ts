import { readFileSync } from "node:fs";
import { childrenOf, locator, type Node, parse } from "./ast.ts";
import type { WorkflowDefinition } from "./define.ts";
import { errorMessage } from "./shared.ts";

/**
 * What a workflow's `run` calls through `ctx`, in the order it makes the calls, with the loops,
 * branches, `try` blocks and `ctx.all` groups around them. Read from the file that defined the
 * workflow, and a contract: `run` may write only what the outline can draw (`outlineBody`'s
 * problems; the worker refuses a workflow with any, the lint reports them), and the worker
 * places every `ctx` call a run makes at its node (`callAt`), refusing one made from code the
 * outline has no node for (`call_not_in_outline`). Every record a call writes names its node
 * (`node`), so a run's steps are the outline's calls and nothing else.
 */
export type Outline =
  /** Read from the file that defined the workflow (`wf.file`): the spans index into its text. */
  { nodes: OutlineNode[]; file: string } | { error: string };

/** Where a node is in the text the outline was read from: UTF-16 offsets, as a string index or CodeMirror counts them. */
export type Span = readonly [start: number, end: number];

/**
 * Each node's `path` is its place in the outline: its index among its siblings, under its
 * parent's path and the index of the branch, case or body it is in (`"2"`, `"2.1.0"`), so the
 * same tree has the same paths however the code is laid out; a ledger record's `node` is one.
 * Each node's `span` is the code it stands for: the call for `op`, `approval` and `sleep`, the
 * `ctx.all(...)` call for `all` and `each`, the loop or the iterating call (`items.map(cb)`) for
 * `repeat`, the whole `if` / `else if` chain, `switch`, `?:` or `&&` for `branch`, and the `try`
 * statement for `try`.
 */
export type OutlineNode = { path: string; span: Span } &
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
    /** `try { body } catch { handler }`: the handler runs when the body fails. A `finally` is not read. */
    | { kind: "try"; body: OutlineNode[]; handler: OutlineNode[] }
  );

/** The node kinds a `ctx` call is: what a call site resolves to (`callAt`). */
export type CallNode = Extract<OutlineNode, { kind: "op" | "approval" | "sleep" | "all" | "each" }>;

/** Something in `run` the outline cannot draw, at an offset into the file, and what to write instead. */
export interface OutlineProblem {
  start: number;
  message: string;
}

export const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);
export const LOOPS = new Set([
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "WhileStatement",
  "DoWhileStatement",
]);
const ITERATING = new Set(["map", "forEach", "reduce"]);
// Wrappers that leave the expression's value as it is: `ctx!.x`, `(ctx as Ctx).x`, `ctx?.x`.
export const TRANSPARENT = new Set([
  "TSNonNullExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "ChainExpression",
]);

/**
 * Outlines a workflow from the file that defined it (`wf.file`): TypeScript or, once built,
 * JavaScript. Counts only calls on `run`'s first parameter, whatever it is named. Returns
 * `{ error }` when the file cannot be read or parsed, holds no workflow of that name, `run`
 * takes no `ctx` by name, or `run` holds what the outline cannot draw (each problem at
 * `file:line:column`).
 */
export const outlineWorkflow = (wf: WorkflowDefinition<any, any>): Outline => outlineWithSource(wf).outline;

/**
 * `outlineWorkflow`, with the text its spans index into: the file's, with `\n` line endings.
 * No text with an `{ error }`.
 */
export function outlineWithSource(wf: WorkflowDefinition<any, any>): { outline: Outline; source?: string } {
  const found = inFile(wf.file, wf.name);
  if (typeof found === "string") return { outline: { error: found } };
  const { source, fn } = found;
  // A run without a ctx parameter makes no calls; one that destructures it cannot be read.
  const param = unwrap(fn.params[0]);
  if (param !== undefined && param.type !== "Identifier") {
    return { outline: { error: `${wf.name}'s run takes no ctx parameter by name, so its calls cannot be read` } };
  }
  const { nodes, problems } = param === undefined ? { nodes: [], problems: [] } : outlineBody(fn, param.name);
  if (problems.length) {
    const at = locator(source);
    const lines = problems.map((p) => {
      const { line, column } = at(p.start);
      return `${wf.file}:${line}:${column}: ${p.message}`;
    });
    return { outline: { error: lines.join("\n") } };
  }
  return { source, outline: { nodes: withPaths(nodes, ""), file: wf.file } };
}

/** CodeMirror counts a line break as one unit, oxc counts `\r\n` as two: spans need `\n` alone. */
const lf = (text: string) => text.replaceAll("\r\n", "\n");

/**
 * The workflow's `run` in its file: the literal `defineWorkflow` is called with that has its
 * `name` (a string, or a top-level `const` of the file holding it) and a `run` function. Or why
 * not: the file cannot be read or parsed, or holds no such literal.
 */
function inFile(file: string, name: string): { source: string; fn: Node } | string {
  let source: string;
  try {
    source = lf(readFileSync(file, "utf8"));
  } catch (err) {
    return `${file} could not be read: ${errorMessage(err)}`;
  }
  const { program, errors } = parse(file, source);
  if (errors.length) return `${file} could not be parsed: ${errors[0]!.message}`;
  // The file's top-level string constants, `export const NAME = "drift"`, by name.
  const consts = new Map<string, string>();
  for (const statement of program.body as Node[]) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
    for (const d of declaration.declarations as Node[]) {
      const value = stringValue(d.init);
      if (d.id.type === "Identifier" && value !== undefined) consts.set(d.id.name, value);
    }
  }
  const nameOf = (node: Node) =>
    unwrap(node)?.type === "Identifier" ? consts.get(unwrap(node).name) : stringValue(node);
  const fn = workflowLiterals(program).find((literal) => nameOf(literal.name) === name)?.run;
  return fn ? { source, fn } : `${file} holds no workflow named "${name}"`;
}

/** A node's child lists, in order: the lists a path's segments index into. */
const childLists = (node: OutlineNode): OutlineNode[][] => {
  switch (node.kind) {
    case "all":
      return node.branches;
    case "branch":
      return node.cases;
    case "each":
    case "repeat":
      return [node.body];
    case "try":
      return [node.body, node.handler];
    default:
      return [];
  }
};

/**
 * Numbers the nodes: each its index under `prefix`, its children under its path and their
 * list's index. `outlineBody` leaves every path empty, since a node's place is known once the
 * list it is in is whole; the nodes are freshly built, so they are filled in place.
 */
function withPaths(nodes: OutlineNode[], prefix: string): OutlineNode[] {
  nodes.forEach((node, i) => {
    node.path = `${prefix}${i}`;
    childLists(node).forEach((list, j) => withPaths(list, `${node.path}.${j}.`));
  });
  return nodes;
}

const span = (node: Node): Span => [node.start, node.end];

const CTX_USE =
  "ctx is only called, directly (`await ctx.<vendor>.<resource>.<op>(…)`, `ctx.approval(…)`, `ctx.sleep(…)`, " +
  "`ctx.all([…])`) or read for ctx.runId: passed on, aliased or destructured, its calls are not in the graph";
const UNREAD =
  "a function defined in run uses ctx, and the outline does not read it: inline its calls, or pass it to " +
  "ctx.all, .map, .forEach or .reduce, so the run's graph shows them";
const FINALLY =
  "ctx is not allowed in a finally: the graph does not draw one; move the call after the try, or into the catch";
const RETURN =
  "`return` before the end of run is not allowed in a workflow: the graph runs top to bottom; use if/else around the rest";
const THROW =
  "`throw` outside a catch is not allowed in a workflow: the graph shows no way out; let the failing call end the run, or use if/else";
const BREAK =
  "`break` out of a loop is not allowed in a workflow: the graph repeats the whole body; use if/else, or a condition in the loop";
const CONTINUE =
  "`continue` is not allowed in a workflow: the graph repeats the whole body; use if/else around the rest of it";

/** Where a function's body starts: its own statement rules, nothing of the caller's. */
const bodyOf = (fn: Node): Where => ({ parent: fn, fn, inCatch: false, labels: new Map() });

/** Where the walk is: what a statement may do there. */
interface Where {
  parent: Node;
  /** The function whose body is being read: `run`, or a callback the outline reads. */
  fn: Node;
  inCatch: boolean;
  /** The nearest statement a plain `break` leaves. */
  breakable?: "loop" | "switch";
  /** The labels in scope, and whether each names a loop. */
  labels: ReadonlyMap<string, boolean>;
}

/**
 * The nodes of `fn`'s body (`run`'s, or a callback's the outline reads), each with an empty `path`
 * for `withPaths` to fill, and the problems: what the body does that the graph could not show.
 * `ctx` is only called, directly, or read for `ctx.runId`; a function defined inside that uses
 * `ctx` is read only where the outline reads callbacks (`ctx.all`'s members, `.map`, `.forEach`
 * and `.reduce`), elsewhere it is a problem; a `finally` may not use `ctx`; and in a body the
 * outline reads, `return` comes last, `throw` only in a `catch`, `break` leaves only a `switch`,
 * and there is no `continue`. A callback without `ctx` computes, and is not read.
 */
export function outlineBody(fn: Node, ctx: string): { nodes: OutlineNode[]; problems: OutlineProblem[] } {
  const problems: OutlineProblem[] = [];
  const problem = (node: Node, message: string): OutlineNode[] => {
    problems.push({ start: node.start, message });
    return [];
  };
  const path = "";

  /** True when the code mentions `ctx` anywhere but as a property name. */
  const usesCtx = (node: Node): boolean => {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some(usesCtx);
    if (node.type === "Identifier") return node.name === ctx;
    if (node.type === "Property" && !node.computed) return usesCtx(node.value);
    if (node.type === "MemberExpression" && !node.computed) return usesCtx(node.object);
    return childrenOf(node).some(usesCtx);
  };

  const walk = (node: Node, at: Where): OutlineNode[] => {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap((n) => walk(n, at));
    const inner: Where = { ...at, parent: node };
    const children = (...nodes: Node[]) => nodes.flatMap((n) => walk(n, inner));
    switch (node.type) {
      case "Identifier":
        return node.name === ctx ? problem(node, CTX_USE) : [];
      // A property's name is no reference, `{ ctx: 1 }`, `a.ctx`.
      case "Property":
        return node.computed ? children(node.key, node.value) : children(node.value);
      case "MemberExpression":
        if (ctxPath(node, ctx)?.join(".") === "runId") return [];
        return node.computed ? children(node.object, node.property) : children(node.object);
      case "CallExpression":
        return call(node, inner);
      case "IfStatement":
        return [...children(node.test), ...branch(node, ifArms(node), inner)];
      case "ConditionalExpression":
        return [...children(node.test), ...branch(node, [node.consequent, node.alternate], inner)];
      case "LogicalExpression":
        // The right side may not run: the way past it is an arm with no calls.
        return [...children(node.left), ...branch(node, [node.right, null], inner)];
      case "SwitchStatement":
        return [...children(node.discriminant), ...branch(node, switchArms(node), { ...inner, breakable: "switch" })];
      case "ForStatement":
        return [...children(node.init), ...repeat(node, [node.test, node.body, node.update], inner)];
      case "ForOfStatement":
      case "ForInStatement":
        return [...children(node.right), ...repeat(node, [node.left, node.body], inner)];
      case "WhileStatement":
        return repeat(node, [node.test, node.body], inner);
      case "DoWhileStatement":
        return repeat(node, [node.body, node.test], inner);
      case "LabeledStatement":
        return walk(node.body, {
          ...inner,
          labels: new Map(at.labels).set(node.label.name, LOOPS.has(node.body?.type)),
        });
      case "TryStatement": {
        const inside = children(node.block);
        const handler = walk(node.handler?.body, { ...inner, inCatch: true });
        if (usesCtx(node.finalizer)) problem(node.finalizer, FINALLY);
        return inside.length || handler.length ? [{ kind: "try", path, body: inside, handler, span: span(node) }] : [];
      }
      case "ReturnStatement": {
        const body = at.fn.body;
        if (!(body?.type === "BlockStatement" && at.parent === body && body.body.at(-1) === node))
          problem(node, RETURN);
        return children(node.argument);
      }
      case "ThrowStatement":
        if (!at.inCatch) problem(node, THROW);
        return children(node.argument);
      case "BreakStatement":
        if (node.label ? at.labels.get(node.label.name) : at.breakable === "loop") problem(node, BREAK);
        return [];
      case "ContinueStatement":
        return problem(node, CONTINUE);
    }
    // A function's body runs when the function is called, wherever and however often that is,
    // which a reading of the source cannot follow. Only the callbacks of ctx.all and of `.map`,
    // `.forEach` and `.reduce` are read, where they are passed (`call`, `all`).
    if (FUNCTIONS.has(node.type)) return usesCtx(node) ? problem(node, UNREAD) : [];
    return childrenOf(node).flatMap((child) => walk(child, inner));
  };

  // The arms that make calls, and one empty arm when some arm makes none: the way past them.
  const branch = (node: Node, arms: Node[], at: Where): OutlineNode[] => {
    const walked = arms.map((arm) => walk(arm, at));
    const cases = walked.filter((c) => c.length > 0);
    if (!cases.length) return [];
    if (cases.length < walked.length) cases.push([]);
    return [{ kind: "branch", path, cases, span: span(node) }];
  };

  const repeat = (node: Node, parts: Node[], at: Where): OutlineNode[] => {
    const inside = parts.flatMap((part) => walk(part, { ...at, breakable: "loop" }));
    return inside.length ? [{ kind: "repeat", path, body: inside, span: span(node) }] : [];
  };

  // The arguments are evaluated before the call is made, so their calls come first.
  const call = (node: Node, at: Where): OutlineNode[] => {
    const args: Node[] = node.arguments;
    const members = ctxPath(node.callee, ctx);
    if (members) {
      const id = members.join(".");
      switch (id) {
        case "all":
          return all(node, at);
        case "approval": {
          const title = stringValue(args[0]);
          return [
            ...walk(args, at),
            { kind: "approval", path, span: span(node), ...(title === undefined ? {} : { title }) },
          ];
        }
        case "sleep":
          return [...walk(args, at), { kind: "sleep", path, span: span(node) }];
        default:
          return members.length === 3
            ? [...walk(args, at), { kind: "op", path, id, span: span(node) }]
            : walk(args, at);
      }
    }
    const callee = unwrap(node.callee);
    const [callback, ...rest] = args;
    if (callee?.type === "MemberExpression" && !callee.computed && ITERATING.has(callee.property.name)) {
      if (FUNCTIONS.has(callback?.type) && usesCtx(callback)) {
        return [...walk(callee.object, at), ...walk(rest, at), ...repeat(node, [callback.body], bodyOf(callback))];
      }
    }
    return [...walk(node.callee, at), ...walk(args, at)];
  };

  // `node` is the `ctx.all(...)` call.
  const all = (node: Node, at: Where): OutlineNode[] => {
    const whole = span(node);
    const arg = node.arguments[0];
    if (arg?.type === "ArrayExpression") {
      return [{ kind: "all", path, branches: arg.elements.map((m: Node) => member(m, at)), span: whole }];
    }
    // Otherwise the members are computed, typically `items.map((item) => () => ctx.…)`.
    const made = unwrap(arg);
    const callback =
      made?.type === "CallExpression" ? made.arguments.find((a: Node) => FUNCTIONS.has(a?.type)) : undefined;
    if (!callback) return [...walk(arg, at), { kind: "each", path, body: [], span: whole }];
    return [
      ...walk(made.callee, at),
      { kind: "each", path, body: member(callback.body, bodyOf(callback)), span: whole },
    ];
  };

  // What a member does: a function's body, read where the function is passed, or else the calls
  // the expression makes.
  const member = (node: Node, at: Where): OutlineNode[] => {
    const callback = unwrap(node);
    return FUNCTIONS.has(callback?.type) ? walk(callback.body, bodyOf(callback)) : walk(node, at);
  };

  return { nodes: walk(fn.body, bodyOf(fn)), problems };
}

/** Every node of the outline, nested ones included, in order. */
export function flatten(nodes: readonly OutlineNode[]): OutlineNode[] {
  return nodes.flatMap((node) => [node, ...flatten(childLists(node).flat())]);
}

const CALLS = new Set<OutlineNode["kind"]>(["op", "approval", "sleep", "all", "each"]);

/** The outline's call nodes, wherever they are in it, in order: what `callAt` searches. */
export const callsOf = (nodes: readonly OutlineNode[]): CallNode[] =>
  flatten(nodes).filter((node): node is CallNode => CALLS.has(node.kind));

/** What a call node is called as on `ctx`: the operation's id (`*` for a computed segment), or `all`, `approval`, `sleep`. */
export const callName = (node: CallNode): string =>
  node.kind === "op" ? node.id : node.kind === "each" ? "all" : node.kind;

/**
 * The call a position in the source belongs to: the innermost of `calls` (`callsOf`) whose span
 * holds the offset, as a stack frame places a call at its callee (`ctx.ghost.post.create(…)` at
 * `create`). A call inside another's arguments is the inner one. None when no call's code holds
 * it: a call made from a helper, or from a function defined inside `run`, which the outline does
 * not read.
 */
export function callAt(calls: readonly CallNode[], offset: number): CallNode | undefined {
  let best: CallNode | undefined;
  for (const node of calls) {
    const [start, end] = node.span;
    if (offset < start || offset >= end) continue;
    if (!best || end - start < best.span[1] - best.span[0]) best = node;
  }
  return best;
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
export function ctxPath(callee: Node, ctx: string): string[] | undefined {
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

/** The node under the wrappers that leave its value as it is, and a default's pattern. */
export function unwrap(node: Node): Node {
  let n = node;
  while (n && (TRANSPARENT.has(n.type) || n.type === "AssignmentPattern")) {
    n = n.type === "AssignmentPattern" ? n.left : n.expression;
  }
  return n;
}

/**
 * Every workflow literal in a parsed file: the object literal `defineWorkflow({ name, …, run })`
 * is called with, when it has a `name` and a `run` function. For the outline, which picks the
 * one by its name, and the lint, which checks each `run`.
 */
export function workflowLiterals(program: Node): { name: Node; run: Node }[] {
  const found: { name: Node; run: Node }[] = [];
  const find = (node: Node) => {
    if (!node) return;
    const literal = unwrap(node.arguments?.[0]);
    if (
      node.type === "CallExpression" &&
      unwrap(node.callee)?.name === "defineWorkflow" &&
      literal?.type === "ObjectExpression"
    ) {
      const value = (key: string) =>
        literal.properties.find(
          (p: Node) => p.type === "Property" && !p.computed && (p.key.name ?? p.key.value) === key,
        )?.value;
      const run = value("run");
      const name = value("name");
      if (name && FUNCTIONS.has(run?.type)) found.push({ name, run });
    }
    for (const child of childrenOf(node)) find(child);
  };
  find(program);
  return found;
}
