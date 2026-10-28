import { createContext, useContext } from "react";

// What a page asks the agent through the chat: New workflow, New app and an app's Add open the
// chat column on a new chat with a prompt in its composer, which the person finishes and sends.
// The chrome (`app-chrome.tsx`) provides it; there is none outside the chrome.

/** The chat, as a page opens it with a prompt (`useChatPrompt`). */
export interface ChatPrompt {
  /** Opens the chat column on a new chat with `text` in its composer, focused at its end, not sent. */
  open(text: string): void;
}

/** A prompt the chat column opens with: its new chat's id, and the composer's text. */
export interface Prompt {
  id: string;
  text: string;
}

export const ChatPromptContext = createContext<ChatPrompt | undefined>(undefined);

/** The chat's prompt handle; undefined outside the chrome, so a page leaves its button out. */
export const useChatPrompt = (): ChatPrompt | undefined => useContext(ChatPromptContext);
