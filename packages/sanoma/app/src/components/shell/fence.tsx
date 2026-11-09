import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockLine,
} from "#/components/ui/code-block.tsx";
import { useHighlightedCode } from "#/hooks/use-highlighted-code.ts";

/** A fenced block in a reply: its lines plain until the highlighter and its language have loaded. */
export default function Fence({ text, language }: { text: string; language: string }) {
  const lines = useHighlightedCode(text, language);
  return (
    <CodeBlock>
      <CodeBlockActions>
        <CodeBlockCopyButton value={text} />
      </CodeBlockActions>
      <CodeBlockContent>
        {lines.map((line, i) => (
          <CodeBlockLine key={i}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}
