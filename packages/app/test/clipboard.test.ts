import { describe, expect, it } from "vitest";
import { cellText, csv, delimited } from "../src/components/grid/clipboard.ts";

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
});
