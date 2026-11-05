import { type Components, Streamdown } from "streamdown";

// A reply's text as Markdown, streamed (Streamdown closes what is still open), in the app's own
// classes: a company's Tailwind does not scan Streamdown's install, so its defaults would draw
// unstyled. No image is ever loaded: what a reply says can come from what the agent read, and an
// image's address would carry data out without anyone clicking. Links are Streamdown's hardened
// ones; a fenced block is plain, the code itself, with no highlighter to load.

const heading = "mt-1 font-medium first:mt-0";

const ELEMENTS: Components = {
  h1: ({ node: _node, ...props }) => <h3 {...props} className={`${heading} text-base`} />,
  h2: ({ node: _node, ...props }) => <h3 {...props} className={`${heading} text-base`} />,
  h3: ({ node: _node, ...props }) => <h3 {...props} className={heading} />,
  h4: ({ node: _node, ...props }) => <h4 {...props} className={heading} />,
  h5: ({ node: _node, ...props }) => <h5 {...props} className={heading} />,
  h6: ({ node: _node, ...props }) => <h6 {...props} className={heading} />,
  ul: ({ node: _node, ...props }) => <ul {...props} className="flex list-disc flex-col gap-1 pl-5" />,
  ol: ({ node: _node, ...props }) => <ol {...props} className="flex list-decimal flex-col gap-1 pl-5" />,
  strong: ({ node: _node, ...props }) => <strong {...props} className="font-medium" />,
  a: ({ node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4" />
  ),
  blockquote: ({ node: _node, ...props }) => <blockquote {...props} className="border-l pl-3 text-muted-foreground" />,
  hr: () => <hr className="border-border" />,
  inlineCode: ({ node: _node, ...props }) => (
    <code {...props} className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.875em]" />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre
      {...props}
      className="overflow-x-auto rounded-lg bg-card p-3 font-mono text-xs ring-1 ring-border [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[1em]"
    />
  ),
  code: ({ node: _node, ...props }) => <code {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="overflow-x-auto">
      <table {...props} className="w-full text-sm" />
    </div>
  ),
  th: ({ node: _node, ...props }) => <th {...props} className="border-b px-2 py-1 text-left font-medium" />,
  td: ({ node: _node, ...props }) => <td {...props} className="border-b px-2 py-1" />,
};

/** A reply's text: `live` while it is still streaming. */
export default function Markdown({ text, live }: { text: string; live: boolean }) {
  return (
    <Streamdown
      className="flex min-w-0 flex-col gap-3 text-reply wrap-break-word"
      components={ELEMENTS}
      controls={false}
      disallowedElements={["img"]}
      isAnimating={live}
      linkSafety={{ enabled: false }}
    >
      {text}
    </Streamdown>
  );
}
