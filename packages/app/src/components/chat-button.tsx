import type { ComponentProps } from "react";
import { Button } from "#/components/ui/button.tsx";
import { cn } from "#/lib/utils.ts";
import { useChatPrompt } from "./shell/chat-prompt.ts";

// A button that asks the agent: New workflow, New app, an app's Add. The agent drafts the change
// on a branch of its own and checks it; you merge it.

/**
 * A button opening the chat with `prompt` in its composer (`useChatPrompt`); hidden on a phone,
 * which has no chat column.
 */
export function ChatButton({
  prompt,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick"> & { prompt: string }) {
  const chat = useChatPrompt();
  return <Button size="sm" className={cn("max-md:hidden", className)} {...props} onClick={() => chat.open(prompt)} />;
}
