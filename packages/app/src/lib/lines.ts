import type { Text } from "@codemirror/state";
import type { Span } from "@sanoma/workflows/describe";

/**
 * The numbers of the lines a list of [start, end) ranges touches, in order, once each. Offsets
 * are UTF-16, CodeMirror's; past the end of the document they clamp to it.
 */
export function highlightedLines(doc: Text, spans: Iterable<Span>): number[] {
  const lines = new Set<number>();
  for (const [start, end] of spans) {
    const first = doc.lineAt(Math.min(start, doc.length)).number;
    // `end` is exclusive: a span that ends just after a newline does not touch the next line.
    const last = doc.lineAt(Math.min(Math.max(start, end - 1), doc.length)).number;
    for (let line = first; line <= last; line++) lines.add(line);
  }
  return [...lines].toSorted((a, b) => a - b);
}

/**
 * The first and last line numbers (from 1) a [start, end) range touches in `text`, as
 * `highlightedLines` counts them: for "Lines 3–5" beside a node, where the source is plain text.
 */
export function spanLines(text: string, [start, end]: Span): [number, number] {
  // The line an offset is on: one more than the newlines before it.
  const lineAt = (offset: number) => {
    let line = 1;
    for (let at = text.indexOf("\n"); at !== -1 && at < offset; at = text.indexOf("\n", at + 1)) line++;
    return line;
  };
  return [lineAt(Math.min(start, text.length)), lineAt(Math.min(Math.max(start, end - 1), text.length))];
}
