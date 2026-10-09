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
