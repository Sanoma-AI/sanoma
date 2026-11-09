import sanoma from "../../icon-small.svg?url";
import type { EngineName } from "../../lib/chat.ts";
import { Logo } from "../logo.tsx";
import claudeCode from "./ai-logos/claude-code.svg?url";
import claude from "./ai-logos/claude.svg?url";
import codexDark from "./ai-logos/codex-dark.svg?url";
import codex from "./ai-logos/codex.svg?url";
import copilotDark from "./ai-logos/copilot-dark.svg?url";
import copilot from "./ai-logos/copilot.svg?url";
import openaiDark from "./ai-logos/openai-dark.svg?url";
import openai from "./ai-logos/openai.svg?url";
import opencodeDark from "./ai-logos/opencode-dark.svg?url";
import opencode from "./ai-logos/opencode.svg?url";
import piDark from "./ai-logos/pi-dark.svg?url";
import pi from "./ai-logos/pi.svg?url";

/** The AIs' marks, by name: in their brand colours, or one colour with a `dark` file for the dark theme. */
const MARKS = {
  sanoma: { src: sanoma },
  claude: { src: claude },
  "claude-code": { src: claudeCode },
  openai: { src: openai, dark: openaiDark },
  codex: { src: codex, dark: codexDark },
  copilot: { src: copilot, dark: copilotDark },
  opencode: { src: opencode, dark: opencodeDark },
  pi: { src: pi, dark: piDark },
} satisfies Record<string, { src: string; dark?: string }>;

export type AiMark = keyof typeof MARKS;

/** Each engine's mark: our loop is Sanoma's, a coding agent its maker's, on our key or the person's plan. */
export const ENGINE_MARKS: Record<EngineName, AiMark> = {
  loop: "sanoma",
  pi: "pi",
  "claude-code": "claude-code",
  "acp-copilot": "copilot",
  "acp-opencode": "opencode",
  "acp-pi": "pi",
  "acp-claude-code": "claude-code",
  "acp-codex": "codex",
};

/**
 * An AI's mark, 16 px unless `className` sizes it, as `Logo` draws it. `alt` is `""` by default,
 * for a mark beside its name; give it the name where the mark stands alone.
 */
export function AiLogo({ mark, alt = "", className }: { mark: AiMark; alt?: string; className?: string }) {
  return <Logo {...MARKS[mark]} alt={alt} className={className} />;
}
