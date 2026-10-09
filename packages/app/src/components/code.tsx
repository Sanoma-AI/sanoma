import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, RangeSet } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutterLineClass, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { Span } from "@sanoma/workflows/describe";
import { useEffect, useRef } from "react";
import { highlightedLines } from "#/lib/lines.ts";
import { cn } from "#/lib/utils.ts";

// A workflow's source, read-only, drawn with CodeMirror. It needs the DOM, so the pages load
// this module only in the browser (CodePanel in common.tsx: React.lazy, once seen); the server
// renders the source as plain text instead. Colours come from the --code-* tokens in style.css,
// so `.dark` flips the view with the rest of the page.

export interface CodeProps {
  source: string;
  /** The lines these spans touch are marked, and the first is scrolled to the middle. */
  highlight?: Span[];
  /** Called with the offset nearest a click: in the text, or the start of a clicked line number's line. */
  onSelect?: (offset: number) => void;
  className?: string;
}

const lineMark = Decoration.line({ class: "cm-hl" });

class GutterMark extends GutterMarker {
  override elementClass = "cm-hl-gutter";
}
const gutterMark = new GutterMark();

/** The highlighted lines, marked in the text and in the gutter: reconfigured as the highlight changes. */
const marks = new Compartment();

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--foreground)", backgroundColor: "var(--background)" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.6" },
  ".cm-gutters": {
    color: "var(--muted-foreground)",
    backgroundColor: "var(--background)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": { paddingLeft: "0.75rem" },
  ".cm-hl": { backgroundColor: "var(--code-highlight)" },
  ".cm-gutterElement.cm-hl-gutter": {
    color: "var(--foreground)",
    backgroundColor: "var(--code-highlight)",
    boxShadow: "inset 2px 0 var(--primary)",
  },
});

const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--code-keyword)" },
  { tag: [tags.string, tags.regexp], color: "var(--code-string)" },
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--code-number)" },
  { tag: [tags.punctuation, tags.operator], color: "var(--code-punctuation)" },
]);

// Read-only for now: an editing switch becomes a prop then.
const extensions = [
  EditorView.editable.of(false),
  lineNumbers(),
  javascript({ typescript: true }),
  syntaxHighlighting(highlightStyle),
  theme,
  marks.of([]),
];

export default function Code({ source, highlight, onSelect, className }: CodeProps) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  /** The first highlighted line the view was last scrolled to. */
  const scrolledTo = useRef<number>(undefined);

  // A view per source: sources change rarely.
  useEffect(() => {
    const created = new EditorView({ parent: parent.current!, state: EditorState.create({ doc: source, extensions }) });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
      scrolledTo.current = undefined;
    };
  }, [source]);

  // After the view: a new one has no marks, so `source` is a dependency here too. `highlight` is
  // one by value (highlightKey), so a new array of the same spans changes nothing.
  const highlightKey = (highlight ?? []).map((span) => span.join(":")).join(",");
  useEffect(() => {
    const current = view.current!;
    const { doc } = current.state;
    const lines = highlightedLines(doc, highlight ?? []);
    const first = lines[0];
    const scroll = first !== undefined && first !== scrolledTo.current;
    scrolledTo.current = first;
    current.dispatch({
      effects: [
        marks.reconfigure([
          EditorView.decorations.of(Decoration.set(lines.map((n) => lineMark.range(doc.line(n).from)))),
          gutterLineClass.of(RangeSet.of(lines.map((n) => gutterMark.range(doc.line(n).from)))),
        ]),
        ...(scroll ? [EditorView.scrollIntoView(doc.line(first).from, { y: "center" })] : []),
      ],
    });
  }, [source, highlightKey]);

  // The nearest position: a line number gives its line's start, a click past a line's end or
  // below the last line the nearest line's.
  return (
    <div
      ref={parent}
      className={cn("size-full font-mono text-xs", onSelect && "cursor-pointer", className)}
      onMouseDown={
        onSelect && ((event) => onSelect(view.current!.posAtCoords({ x: event.clientX, y: event.clientY }, false)))
      }
    />
  );
}
