import { Logo } from "#/components/logo.tsx";
import sanoma from "../../icon-small.svg?url";
import type { EngineOption } from "../../lib/chat.ts";

/** An engine's mark, beside its label: its agent's, from its connector, or Sanoma's for our loop. */
export function EngineMark({ engine }: { engine: EngineOption }) {
  const mark = engine.agent === "loop" ? { src: sanoma } : engine.mark;
  return mark ? <Logo {...mark} alt="" /> : null;
}
