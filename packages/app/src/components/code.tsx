import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutterLineClass,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useEffectEvent, useRef } from "react";
import { cn } from "#/lib/utils.ts";

// A workflow's source, read-only, drawn with CodeMirror. It needs the DOM, so the pages load
// this module only in the browser (CodePanel in common.tsx: React.lazy, once seen); the server
// renders the source as plain text instead. Colours come from the --code-* tokens in style.css,
// so `.dark` flips the view with the rest of the page.

/** A range of `source`, in UTF-16 offsets (CodeMirror's units). */
export type Span = readonly [start: number, end: number];

export interface CodeProps {
  source: string;
  /** The lines these spans touch are marked, and the first is scrolled to the middle. */
  highlight?: Span[];
  /** Called with the offset of a click in the text, or of the start of a clicked line number. */
  onSelect?: (offset: number) => void;
  className?: string;
}

/** The numbers of the lines the spans touch, in order, once each. Offsets past the end clamp. */
export function highlightedLines(doc: Text, spans: readonly Span[]): number[] {
  const lines = new Set<number>();
  for (const [start, end] of spans) {
    const first = doc.lineAt(Math.min(start, doc.length)).number;
    // `end` is exclusive: a span that ends just after a newline does not touch the next line.
    const last = doc.lineAt(Math.min(Math.max(start, end - 1), doc.length)).number;
    for (let line = first; line <= last; line++) lines.add(line);
  }
  return [...lines].toSorted((a, b) => a - b);
}

/** Replaces the highlighted spans; null clears them. */
const setHighlight = StateEffect.define<readonly Span[] | null>();

const lineMark = Decoration.line({ class: "cm-hl" });

/** The highlighted lines, as line decorations. A new document clears them. */
const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    if (tr.docChanged) value = Decoration.none;
    for (const effect of tr.effects) {
      if (!effect.is(setHighlight)) continue;
      const builder = new RangeSetBuilder<Decoration>();
      for (const n of highlightedLines(tr.state.doc, effect.value ?? [])) {
        const { from } = tr.state.doc.line(n);
        builder.add(from, from, lineMark);
      }
      value = builder.finish();
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class GutterMark extends GutterMarker {
  override elementClass = "cm-hl-gutter";
}
const gutterMark = new GutterMark();

/** The same lines' numbers, marked in the gutter. */
const gutterMarks = gutterLineClass.compute([highlightField], (state) => {
  const builder = new RangeSetBuilder<GutterMarker>();
  for (let it = state.field(highlightField).iter(); it.value; it.next()) builder.add(it.from, it.from, gutterMark);
  return builder.finish();
});

/**
 * Whether the text can be changed. Read-only for now; a later switch reconfigures this
 * compartment to make the view an editor.
 */
const editable = new Compartment();
const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--foreground)", backgroundColor: "var(--background)" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--foreground)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-content ::selection, .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklch, var(--ring) 35%, transparent)",
  },
  ".cm-gutters": {
    color: "var(--muted-foreground)",
    backgroundColor: "var(--background)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": { cursor: "pointer", paddingLeft: "0.75rem" },
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
  { tag: tags.comment, color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--code-number)" },
  { tag: tags.propertyName, color: "var(--code-property)" },
  { tag: [tags.punctuation, tags.operator], color: "var(--code-punctuation)" },
]);

export default function Code({ source, highlight, onSelect, className }: CodeProps) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const select = useEffectEvent((offset: number) => onSelect?.(offset));

  // One view for the component's life; the effects below put the source and the highlight in it.
  useEffect(() => {
    const created = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        extensions: [
          editable.of(readOnly),
          lineNumbers({
            domEventHandlers: {
              mousedown(_, line) {
                select(line.from);
                return false;
              },
            },
          }),
          javascript({ typescript: true }),
          syntaxHighlighting(highlightStyle),
          highlightField,
          gutterMarks,
          theme,
          EditorView.domEventHandlers({
            mousedown(event, target) {
              const offset = target.posAtCoords({ x: event.clientX, y: event.clientY });
              if (offset !== null) select(offset);
              return false;
            },
          }),
        ],
      }),
    });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const current = view.current!;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: source } });
  }, [source]);

  // After the source: a new document clears the highlight, so this puts it back.
  useEffect(() => {
    const current = view.current!;
    const { doc } = current.state;
    const [first] = highlightedLines(doc, highlight ?? []);
    current.dispatch({
      effects:
        first === undefined
          ? setHighlight.of(null)
          : [setHighlight.of(highlight!), EditorView.scrollIntoView(doc.line(first).from, { y: "center" })],
    });
  }, [source, highlight]);

  return <div ref={parent} className={cn("size-full font-mono text-xs", className)} />;
}
