import { createElement, type ElementType, lazy, Suspense } from "react";
import { type Components, Streamdown } from "streamdown";
import { CodeBlock, CodeBlockContent } from "#/components/ui/code-block.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { Table, TableCell, TableHead } from "#/components/ui/table.tsx";

// A reply's text as Markdown, streamed (Streamdown closes what is still open), in the app's own
// classes: a company's Tailwind does not scan Streamdown's install, so every element it draws with
// a class of its own is given here, and `space-y-0` takes its root's away. No image is ever loaded:
// what a reply says can come from what the agent read, and an image's address would carry data out
// without anyone clicking. Links are Streamdown's hardened ones; a fenced block is the kit's
// CodeBlock, its highlighter and each language loaded the first time one is shown.

/** An element as `tag` with `className`, without the `node` Streamdown passes a component. */
const styled =
  (tag: ElementType, className: string) =>
  <Props extends object>({ node: _node, ...props }: Props & { node?: unknown }) =>
    createElement(tag, { ...props, className });

/** Shiki's core with it, so a reply with no code does not load it. */
const Fence = lazy(() => import("./fence.tsx"));

/** A fenced block's code; `<code>` with markup inside, which only raw HTML writes, stays as it came. */
const FencedCode: Components["code"] = ({ node: _node, className, children }) => {
  if (typeof children !== "string") return <code className={className}>{children}</code>;
  const text = children.replace(/\n$/, "");
  return (
    <Suspense
      fallback={
        <CodeBlock>
          <CodeBlockContent>{text}</CodeBlockContent>
        </CodeBlock>
      }
    >
      <Fence text={text} language={className?.replace("language-", "") ?? ""} />
    </Suspense>
  );
};

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
  hr: () => <Separator />,
  inlineCode: styled("code", "rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.875em]"),
  code: FencedCode,
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
