import { createContext, useContext } from "react";

// What a page asks the agent through the chat: New workflow, New app and an app's Add open the
// chat column on a new chat with a prompt in its composer, which the person finishes and sends; a
// suggested ask sends its text at once; the menu's Agent… shows the agents to connect.
// The chrome (`app-chrome.tsx`) provides it.

/** The chat, as a page opens it with a prompt (`useChatPrompt`). */
export interface ChatPrompt {
  /** Opens the chat column on a new chat with `text` in its composer, focused at its end, not sent; sent at once with `send`. */
  open(text: string, options?: { send?: boolean }): void;
  /** Opens the chat column on a new chat that shows the agents to connect, whatever is connected. */
  chooseAgent(): void;
}

/** A prompt the chat column opens with: its new chat's id, the composer's text, and whether it is sent at once or the agents shown. */
export interface Prompt {
  id: string;
  text: string;
  send?: boolean;
  choose?: boolean;
}

export const ChatPromptContext = createContext<ChatPrompt | null>(null);

/** The chat's prompt handle, which the chrome provides to every page. */
export function useChatPrompt(): ChatPrompt {
  const chat = useContext(ChatPromptContext);
  if (!chat) throw new Error("useChatPrompt is used outside the chrome, which provides the chat");
  return chat;
}
