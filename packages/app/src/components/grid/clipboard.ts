// A grid's cells as text, the way spreadsheets read them: tab-separated for the clipboard, so a
// copy pastes into Excel or Sheets cell for cell, and comma-separated for a download. Pure, no
// DOM: the grid hands it the cells' values (`getSelectedCellRangesData`, or the rows shown).

/** A cell's value as text: empty for none, a list or an object as JSON, anything else as itself. */
export function cellText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Rows of values as delimited text: each cell `cellText`, quoted (its quotes doubled) when it
 * holds the delimiter, a quote or a line break, so a pasted or opened sheet gains no phantom
 * cells. Rows end with CRLF, as RFC 4180 and the spreadsheets' own copies do; the last has none.
 */
export function delimited(rows: readonly (readonly unknown[])[], delimiter: "\t" | ","): string {
  const special = delimiter === "\t" ? /[\t"\r\n]/ : /[,"\r\n]/;
  const quoted = (text: string) => (special.test(text) ? `"${text.replaceAll('"', '""')}"` : text);
  return rows.map((row) => row.map((value) => quoted(cellText(value))).join(delimiter)).join("\r\n");
}
