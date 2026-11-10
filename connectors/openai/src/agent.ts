import type { CodingAgent } from "sanoma/workflows";

/**
 * Codex, the chat's coding agent on a person's own plan: Zed's `codex-acp` over the Agent Client
 * Protocol, signed in with the person's ChatGPT account by its device code in the chat. Not on the
 * company's key: its `HarnessAgent` adapter runs only `allow-all`, so nothing could answer its
 * edits and commands (vercel/ai#22550).
 */
export const codex: CodingAgent = {
  own: {
    packages: ["@agentclientprotocol/codex-acp@2.2.2"],
    bin: "codex-acp",
    args: [],
    signIn: { authenticate: "chat-gpt-device-code" },
  },
};
