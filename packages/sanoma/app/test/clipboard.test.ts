import { describe, expect, it } from "vitest";
import { cellsOf, cellText, csv, delimited } from "../src/components/grid/clipboard.ts";

// The grid's cells as text (`components/grid/clipboard.ts`): pure, no browser.

describe("the grid's cells as text", () => {
  it("writes each value as a spreadsheet reads it", () => {
    expect([undefined, null, "", "Acme", 12, 0.5, true, false].map(cellText)).toEqual([
      "",
      "",
      "",
      "Acme",
      "12",
      "0.5",
      "true",
      "false",
    ]);
    expect(cellText({ a: 1 })).toBe('{"a":1}');
    expect(cellText(["x", 2])).toBe('["x",2]');
  });

  it("separates cells by tabs for the clipboard, quoting only what holds a tab, a quote or a line break", () => {
    const rows = [
      ["Acme", "contacted", 12],
      ["Tab\there", 'Say "hi"', "two\nlines"],
      ["a,b", undefined, true],
    ];
    expect(delimited(rows, "\t")).toBe('Acme\tcontacted\t12\r\n"Tab\there"\t"Say ""hi"""\t"two\nlines"\r\na,b\t\ttrue');
  });

  it("separates cells by commas for a download, quoting what holds a comma", () => {
    expect(
      delimited(
        [
          ["company", "note"],
          ["a,b", "plain"],
          ["Tab\there", "cr\rhere"],
        ],
        ",",
      ),
    ).toBe('company,note\r\n"a,b",plain\r\nTab\there,"cr\rhere"');
    expect(delimited([], ",")).toBe("");
  });

  it("writes a download's text cell that a spreadsheet would read as a formula as text", () => {
    expect(csv([["=SUM(A1)", "+1", "-x", "@me", "\tpad", "plain", -5, "a=b"]])).toBe(
      "'=SUM(A1),'+1,'-x,'@me,'\tpad,plain,-5,a=b",
    );
  });

  it("reads a paste's text as rows of cells: tabs between cells, a line break between rows", () => {
    expect(cellsOf("Acme\tcontacted\nGlobex\treplied", "\t")).toEqual([
      ["Acme", "contacted"],
      ["Globex", "replied"],
    ]);
    // CRLF and CR end a row too; an empty cell stays a cell.
    expect(cellsOf("a\t\tc\r\nd\re", "\t")).toEqual([["a", "", "c"], ["d"], ["e"]]);
    expect(cellsOf("one", "\t")).toEqual([["one"]]);
    expect(cellsOf("", "\t")).toEqual([]);
  });

  it("starts no row after the line break that ends the last, as Excel copies a range", () => {
    expect(cellsOf("a\tb\r\n", "\t")).toEqual([["a", "b"]]);
    expect(cellsOf("a\n\nb\n", "\t")).toEqual([["a"], [""], ["b"]]);
    expect(cellsOf("a\t", "\t")).toEqual([["a", ""]]);
  });

  it("reads a quoted cell whole, its line breaks, tabs and doubled quotes inside it", () => {
    expect(cellsOf('"two\nlines"\t"Say ""hi"""\n"Tab\there"\tplain', "\t")).toEqual([
      ["two\nlines", 'Say "hi"'],
      ["Tab\there", "plain"],
    ]);
    // A quote inside a cell that does not start with one is the cell's own.
    expect(cellsOf('5" pipe\tx', "\t")).toEqual([['5" pipe', "x"]]);
    // Quotes that do not close the cell, or never close, are the text's own.
    expect(cellsOf('"Pro" plan\tc\n"open\tx', "\t")).toEqual([
      ['"Pro" plan', "c"],
      ['"open', "x"],
    ]);
  });

  it("reads back what the grid copies or downloads, cell for cell", () => {
    const rows = [
      ["Acme", "contacted", "12"],
      ["Tab\there", 'Say "hi"', "two\r\nlines"],
      ["", "a,b", "true"],
    ];
    expect(cellsOf(delimited(rows, "\t"), "\t")).toEqual(rows);
    expect(cellsOf(delimited(rows, ","), ",")).toEqual(rows);
  });

  it("reads a CSV file's text as RFC 4180 writes it: commas between cells, a quoted cell whole", () => {
    expect(cellsOf('name,note\r\n"Globex, Inc.","Say ""hi"""\r\nAcme,\tplain\r\n', ",")).toEqual([
      ["name", "note"],
      ["Globex, Inc.", 'Say "hi"'],
      ["Acme", "\tplain"],
    ]);
  });
});
