import type { ComponentProps } from "react";
import { Button } from "#/components/ui/button.tsx";
import { useChatPrompt } from "./shell/chat-prompt.ts";

// A button that asks the agent: New workflow, New app, an app's Add. The agent drafts the change
// on a branch of its own and checks it; you merge it.

/** A button opening the chat with `prompt` in its composer (`useChatPrompt`); nothing where there is no chat (a demo). */
export function ChatButton({ prompt, ...props }: Omit<ComponentProps<typeof Button>, "onClick"> & { prompt: string }) {
  const chat = useChatPrompt();
  if (!chat) return null;
  return <Button size="sm" {...props} onClick={() => chat.open(prompt)} />;
}
