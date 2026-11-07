// An op node whose id has a computed segment (`*.*.import`), drawn as a stacked list: a header
// naming what is literal in the id, then one row per operation in the workflow's `uses` the id
// fits (the outline's `ops`), with its vendor. Shared by the node component, which draws the
// rows, and the layout, which sizes the node to them.

/** The most rows a node draws: past this, the last row says how many more there are. */
export const MAX_ROWS = 6;
/** The most vendor logos the header draws before saying how many more vendors there are. */
export const MAX_VENDORS = 3;
/** Each row's height in px (a 16px line and the gap), and what the list adds above its rows (the op node's Separator and the frame's gap on each side of it, less the room the header's two lines leave): measured in the browser. */
export const ROW_HEIGHT = 18;
export const LIST_HEADER = 8;

export type WildcardRow =
  /** One operation: the id's segments where the pattern is computed, the vendor's left to its logo. */
  | { id: string; vendor: string; label: string }
  /** A note in the operations' place: how many more there are, or that there are none. */
  | { note: string };

/** What the id says: its literal segments after the vendor, or "any operation" when it has none. */
export function wildcardHeader(pattern: string): string {
  const literal = pattern
    .split(".")
    .slice(1)
    .filter((segment) => segment !== "*");
  return literal.length ? literal.join(".") : "any operation";
}

/** The rows a node with `ops` under `pattern` draws, one per operation up to MAX_ROWS, then a note. */
export function wildcardRows(pattern: string, ops: readonly string[]): WildcardRow[] {
  if (ops.length === 0) return [{ note: "none the workflow uses" }];
  const computed = pattern.split(".");
  const shown = ops.length > MAX_ROWS ? MAX_ROWS - 1 : ops.length;
  const rows: WildcardRow[] = ops.slice(0, shown).map((id) => {
    const segments = id.split(".");
    const own = segments.filter((_, i) => i > 0 && computed[i] === "*");
    return { id, vendor: segments[0]!, label: (own.length ? own : segments.slice(1)).join(".") };
  });
  return shown < ops.length ? [...rows, { note: `+${ops.length - shown} more` }] : rows;
}
