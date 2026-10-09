import { parseSync, visitorKeys } from "oxc-parser";

// What the lint and the outline share: one way to parse a file and one way to walk it.

/** oxc-parser's ESTree nodes, read by shape. */
export type Node = any;

/** Parses TypeScript, which covers the JavaScript a built package holds, as a module. */
export const parse = (filename: string, source: string) =>
  parseSync(filename, source, { lang: "ts", sourceType: "module", preserveParens: false });

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

/** Where an offset into `source` is, as a line and a column, both from 1. */
export function locator(source: string): (offset: number) => { line: number; column: number } {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  return (offset) => {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= offset) line++;
    return { line: line + 1, column: offset - lineStarts[line]! + 1 };
  };
}
