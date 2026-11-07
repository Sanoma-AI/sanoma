// A grid's cells as text, the way spreadsheets read them: tab-separated for the clipboard, so a
// copy pastes into Excel or Sheets cell for cell, and comma-separated for a download (`csv`);
// and back, a paste's text or a CSV file's as cells (`cellsOf`). Pure, no DOM: the grid hands it
// the cells' values (`getSelectedCellRangesData`, or the rows shown), or the clipboard's text,
// and an import (`components/import/`) a file's.

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

/**
 * Delimited text as rows of cells, as Excel and Sheets write a range to the clipboard (a tab
 * between cells) and RFC 4180 a CSV file (a comma): a line break (CRLF, LF or CR) between rows,
 * a cell that holds the delimiter, a quote or a line break in quotes, its quotes doubled
 * (`delimited`'s own). A cell is quoted only where its closing quote ends it: other text with
 * quotes (`"Pro" plan`, an unclosed `"`) is read as it is. The line break after the last row
 * starts none; no text is no cells.
 */
export function cellsOf(text: string, delimiter: "\t" | ","): string[][] {
  // Where a cell's text ends: at the delimiter, or at a line break, which ends its row too.
  const cellEnd = new RegExp(`[${delimiter}\\r\\n]`, "g");
  const rows: string[][] = [];
  let row: string[] = [];
  let at = 0;
  while (at < text.length || row.length > 0) {
    let cell = "";
    if (text[at] === '"') {
      // Quoted: up to the quote that is not doubled, taken only where the cell ends after it.
      let quoted = "";
      for (let from = at + 1; ;) {
        const quote = text.indexOf('"', from);
        if (quote === -1) break;
        quoted += text.slice(from, quote);
        from = quote + 1;
        if (text[from] === '"') {
          quoted += '"';
          from++;
          continue;
        }
        if (from === text.length || `${delimiter}\r\n`.includes(text[from]!)) [cell, at] = [quoted, from];
        break;
      }
    }
    cellEnd.lastIndex = at;
    const end = cellEnd.exec(text);
    cell += text.slice(at, end?.index ?? text.length);
    row.push(cell);
    if (!end) break;
    at = end.index + 1;
    if (end[0] === delimiter) continue;
    if (end[0] === "\r" && text[at] === "\n") at++;
    rows.push(row);
    row = [];
  }
  if (row.length) rows.push(row);
  return rows;
}

/** A cell a spreadsheet would read as a formula: written as text in a download. */
const FORMULA = /^[=+\-@\t\r]/;
const asText = (value: unknown) => (typeof value === "string" && FORMULA.test(value) ? `'${value}` : value);

/** Rows of values as a CSV download: `delimited` by commas, a text cell that reads as a formula kept as text. */
export function csv(rows: readonly (readonly unknown[])[]): string {
  return delimited(
    rows.map((row) => row.map(asText)),
    ",",
  );
}
