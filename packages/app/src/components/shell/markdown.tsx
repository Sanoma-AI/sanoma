import { createElement, type ElementType } from "react";
import { type Components, Streamdown } from "streamdown";
import { Table, TableCell, TableHead } from "#/components/ui/table.tsx";

// A reply's text as Markdown, streamed (Streamdown closes what is still open), in the app's own
// classes: a company's Tailwind does not scan Streamdown's install, so every element it draws with
// a class of its own is given here, and `space-y-0` takes its root's away. No image is ever loaded:
// what a reply says can come from what the agent read, and an image's address would carry data out
// without anyone clicking. Links are Streamdown's hardened ones; a fenced block is plain, the code
// itself, with no highlighter to load.

/** An element as `tag` with `className`, without the `node` Streamdown passes a component. */
const styled =
  (tag: ElementType, className: string) =>
  <Props extends object>({ node: _node, ...props }: Props & { node?: unknown }) =>
    createElement(tag, { ...props, className });

const HEADING = "mt-1 font-medium first:mt-0";
const TITLE = styled("h3", `${HEADING} text-base`);
const CELL = "h-auto border-b py-1 whitespace-normal";

const ELEMENTS: Components = {
  h1: TITLE,
  h2: TITLE,
  h3: styled("h3", HEADING),
  h4: styled("h4", HEADING),
  h5: styled("h5", HEADING),
  h6: styled("h6", HEADING),
  ul: styled("ul", "flex list-disc flex-col gap-1 pl-5"),
  ol: styled("ol", "flex list-decimal flex-col gap-1 pl-5"),
  li: "li",
  strong: styled("strong", "font-medium"),
  a: ({ node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4" />
  ),
  blockquote: styled("blockquote", "border-l pl-3 text-muted-foreground"),
  hr: styled("hr", "border-border"),
  // Every code element, a fenced block's too, once `pre` is ours.
  inlineCode: styled("code", "rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.875em]"),
  pre: styled(
    "pre",
    "overflow-x-auto rounded-lg bg-card p-3 font-mono text-xs ring-1 ring-border [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[1em]",
  ),
  table: ({ node: _node, ...props }) => <Table {...props} />,
  thead: "thead",
  tbody: "tbody",
  tr: "tr",
  th: styled(TableHead, CELL),
  td: styled(TableCell, CELL),
};

/** A reply's text: `live` while it is still streaming. */
export default function Markdown({ text, live }: { text: string; live: boolean }) {
  return (
    <Streamdown
      className="flex min-w-0 flex-col gap-3 space-y-0 text-reply wrap-break-word"
      components={ELEMENTS}
      disallowedElements={["img"]}
      isAnimating={live}
    >
      {text}
    </Streamdown>
  );
}
