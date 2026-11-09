import type { CodingAgent } from "sanoma/workflows";

/**
 * OpenCode, the chat's coding agent on a person's own plan, over the Agent Client Protocol
 * (`opencode acp`). Its free models need no sign-in; for a provider's account the person runs
 * `opencode auth login` once on this computer, since it prints nothing without a terminal.
 */
export const opencodeAgent: CodingAgent = {
  own: {
    packages: ["opencode-ai@1.19.4"],
    setup: "node_modules/opencode-ai/postinstall.mjs",
    bin: "opencode",
    args: ["acp"],
    signIn: { once: { bin: "opencode", args: ["auth", "login"] } },
  },
};
