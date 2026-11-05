import { CatchBoundary } from "@tanstack/react-router";
import { createElement, type ElementType, lazy, Suspense } from "react";
import {
  type Components,
  defaultComponents,
  defaultRehypePlugins,
  type LinkSafetyModalProps,
  Streamdown,
} from "streamdown";
import { Button } from "#/components/ui/button.tsx";
import { CodeBlock, CodeBlockContent } from "#/components/ui/code-block.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { Table, TableCell, TableHead } from "#/components/ui/table.tsx";

// A reply's text as Markdown, streamed (Streamdown closes what is still open), in the app's own
// classes: a company's Tailwind does not scan Streamdown's install, so every element it draws with
// a class of its own is given here, and `space-y-0` takes its root's away. No image is ever loaded:
// what a reply says can come from what the agent read, and an image's address would carry data out
// without anyone clicking. Links are Streamdown's hardened ones, asking before they open (bar an
// in-page anchor); a fenced block is the kit's CodeBlock, its highlighter and each language loaded
// the first time one is shown.

/** An element as `tag` with `className`, without the `node` Streamdown passes a component. */
const styled =
  (tag: ElementType, className: string) =>
  <Props extends object>({ node: _node, ...props }: Props & { node?: unknown }) =>
    createElement(tag, { ...props, className });

/** Shiki's core with it, so a reply with no code does not load it. */
const Fence = lazy(() => import("./fence.tsx"));

/** A fenced block's code. */
const FencedCode: Components["code"] = ({ node: _node, className, children }) => {
  const text = typeof children === "string" ? children.replace(/\n$/, "") : undefined;
  const plain = (
    <CodeBlock>
      <CodeBlockContent className={className}>{text ?? children}</CodeBlockContent>
    </CodeBlock>
  );
  if (text === undefined) return plain;
  // A chunk that does not come leaves the block plain, the rest of the reply as it is.
  return (
    <CatchBoundary getResetKey={() => "fence"} errorComponent={() => plain}>
      <Suspense fallback={plain}>
        <Fence text={text} language={className?.replace("language-", "") ?? ""} />
      </Suspense>
    </CatchBoundary>
  );
};

const StreamdownLink = defaultComponents.a;

/** Before a link leaves the app: the agent wrote it, and a page it reads can steer what it writes. */
function LinkCheck({ url, isOpen, onClose, onConfirm }: LinkSafetyModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open this link?</DialogTitle>
          <DialogDescription>The agent wrote it. It opens in a new tab.</DialogDescription>
        </DialogHeader>
        <p className="font-mono text-xs break-all">{url}</p>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            Open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const LINK_SAFETY = { enabled: true, renderModal: (props: LinkSafetyModalProps) => <LinkCheck {...props} /> };

// Raw HTML is left out (its tags show as the text they are, as `Array<string>` must), so the
// sanitizer and Streamdown's hardening are the rest of its defaults.
const { sanitize, harden } = defaultRehypePlugins;
if (!sanitize || !harden) throw new Error("Streamdown no longer names its sanitize and harden plugins");
const PLUGINS = [sanitize, harden];

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
  // Streamdown's, so an unfinished link is not followed and a click asks first (`LINK_SAFETY`); only
  // an in-page anchor, which leaves nothing, is a plain link, and one with no address is its text.
  a: ({ node: _node, href, ...props }) =>
    !href ? (
      <span>{props.children}</span>
    ) : href.startsWith("#") ? (
      <a {...props} href={href} className="underline underline-offset-4" />
    ) : (
      <StreamdownLink
        {...props}
        href={href}
        className="text-left font-normal text-current wrap-anywhere underline underline-offset-4"
      />
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
      linkSafety={LINK_SAFETY}
      rehypePlugins={PLUGINS}
    >
      {text}
    </Streamdown>
  );
}
