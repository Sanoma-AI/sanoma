import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { highlightedLines } from "../src/lib/lines.ts";

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
