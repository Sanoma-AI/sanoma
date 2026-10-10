import { parseSync, visitorKeys } from "oxc-parser";

// What the lints, the outline and the data-file reader share: one way to parse a file, walk it
// and say where in it a problem is.

/** oxc-parser's ESTree nodes, read by shape. */
export type Node = any;

/** Parses TypeScript, which covers the JavaScript a built package holds, as a module; a `.tsx` or `.jsx` file with its JSX. */
export const parse = (filename: string, source: string) =>
  parseSync(filename, source, {
    lang: /\.[jt]sx$/.test(filename) ? "tsx" : "ts",
    sourceType: "module",
    preserveParens: false,
  });

// The keys that hold types, not code: nothing the lint or the outline looks for is in them.
const TYPE_KEYS = new Set([
  "typeAnnotation",
  "typeParameters",
  "returnType",
  "typeArguments",
  "superTypeArguments",
  "implements",
]);

const CODE_KEYS = new Map(
  Object.entries(visitorKeys).map(([type, keys]) => [type, keys.filter((key) => !TYPE_KEYS.has(key))]),
);

/** A node's children in source order, by oxc-parser's `visitorKeys`, without its types. A hole in a list is `null`. */
export const childrenOf = (node: Node): Node[] => (CODE_KEYS.get(node.type) ?? []).flatMap((key) => node[key] ?? []);

/** The offset each line of `source` starts at, from line 1. */
export const lineStartsOf = (source: string): number[] => {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  return lineStarts;
};

/** Where an offset into `source` is, as a line and a column, both from 1. */
export function locator(source: string): (offset: number) => { line: number; column: number } {
  const lineStarts = lineStartsOf(source);
  return (offset) => {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= offset) line++;
    return { line: line + 1, column: offset - lineStarts[line]! + 1 };
  };
}

/**
 * The offset into `source` of a line and column, both from 1, as a stack frame gives them; or
 * undefined when `source` has no such line, or the line no such column (a frame mapped wrong
 * must not land in the next line). The column is taken as a UTF-16 unit index, as V8 counts it.
 * `lineStarts` is `lineStartsOf(source)`, passed in when the same source is asked about often.
 */
export function offsetOf(
  source: string,
  line: number,
  column: number,
  lineStarts: readonly number[] = lineStartsOf(source),
): number | undefined {
  const start = lineStarts[line - 1];
  if (start === undefined || line < 1 || column < 1) return undefined;
  const offset = start + column - 1;
  // The line ends before its `\n`, or at the end of the text.
  const end = (lineStarts[line] ?? source.length + 1) - 1;
  return offset < end ? offset : undefined;
}

/** Something wrong in a file, at a line and column from 1. */
export interface LintProblem {
  line: number;
  column: number;
  message: string;
}

/** A file parsed, its syntax errors as problems, and offsets as lines and columns from 1. */
export function parsed(source: string, filename: string) {
  const { program, errors } = parse(filename, source);
  const at = locator(source);
  const problems: LintProblem[] = errors.map((e) => ({
    ...at(e.labels?.[0]?.start ?? 0),
    message: `syntax: ${e.message}`,
  }));
  return { program: program as Node, problems, at };
}

/** Problems in the order of their place in the file. */
export const byPosition = <P extends Omit<LintProblem, "message">>(problems: P[]): P[] =>
  problems.toSorted((a, b) => a.line - b.line || a.column - b.column);
