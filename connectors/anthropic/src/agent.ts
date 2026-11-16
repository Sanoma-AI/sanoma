import type { CodingAgent } from "sanoma/workflows";

/**
 * Claude Code's adapter for the AI SDK's `HarnessAgent`, loaded only when a turn runs it on the
 * company's key, by a name the Worker's bundler leaves alone: the adapter runs its bridge in the
 * person's box from files beside its own `dist/`, so it is never bundled.
 */
const ADAPTER = "@ai-sdk/harness-claude-code";

/**
 * Claude Code, the chat's coding agent: on a person's own plan over the Agent Client Protocol
 * (Zed's `claude-agent-acp`, signed in with their Claude account in the chat), and on the
 * company's key through its `HarnessAgent` adapter, on this connector's model and key.
 */
export const claudeCode: CodingAgent = {
  own: {
    packages: ["@agentclientprotocol/claude-agent-acp@0.95.0"],
    bin: "claude-agent-acp",
    args: [],
    signIn: { method: "claude-ai-login" },
    // Its model's API, and its claude.ai sign-in (SSO organisations' too): Anthropic's list,
    // https://code.claude.com/docs/en/network-config.
    hosts: ["api.anthropic.com", "claude.ai", "claude.com", "platform.claude.com", "sso.claude.com"],
  },
  onKey: {
    model: "anthropic",
    baseUrl: "ANTHROPIC_BASE_URL",
    qualified: false,
    bridge: true,
    // Its model's API; its bridge's install is the registry's.
    hosts: ["api.anthropic.com"],
    harness: async (auth) => {
      const { createClaudeCode }: typeof import("@ai-sdk/harness-claude-code") = await import(
        /* @vite-ignore */ ADAPTER
      );
      return createClaudeCode({
        auth,
        env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" },
      });
    },
  },
};
