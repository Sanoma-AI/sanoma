import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { highlightedLines, spanLines } from "../src/lib/lines.ts";

const doc = Text.of(["one", "two", "three", "four", "five", "six"]);
/** The offset of `column` on line `n` (1-based). */
const at = (n: number, column = 0) => doc.line(n).from + column;

describe("highlightedLines", () => {
  it("gives every line a span touches, once each, in order", () => {
    const spans = [
      [at(4, 1), at(5, 2)],
      [at(3, 2), at(4, 1)],
    ] as const;
    expect(highlightedLines(doc, spans)).toEqual([3, 4, 5]);
  });

  it("leaves out the next line when a span ends at its start", () => {
    expect(highlightedLines(doc, [[at(2), at(3)]])).toEqual([2]);
  });

  it("gives none for no spans", () => {
    expect(highlightedLines(doc, [])).toEqual([]);
  });
});

describe("spanLines", () => {
  const text = doc.toString();

  it("gives the first and last line a span touches, as highlightedLines does", () => {
    expect(spanLines(text, [at(3, 2), at(5, 1)])).toEqual([3, 5]);
    expect(spanLines(text, [at(2), at(3)])).toEqual([2, 2]);
    expect(spanLines(text, [at(1), at(1, 2)])).toEqual([1, 1]);
  });

  it("clamps offsets past the end to the last line", () => {
    expect(spanLines(text, [text.length + 5, text.length + 9])).toEqual([6, 6]);
  });
});
