import { join } from "node:path";
import type { CodingAgent } from "sanoma/workflows";

/**
 * Pi's adapter for the AI SDK's `HarnessAgent`, loaded only when a turn runs it on the company's
 * key, by a name the Worker's bundler leaves alone: it and its model providers are never bundled.
 */
const ADAPTER = "@ai-sdk/harness-pi";

/**
 * Pi, the chat's coding agent: on a person's own plan over the Agent Client Protocol (`pi-acp`
 * over Pi's coding agent; its sign-in is Pi's own terminal UI, run once on this computer), and on
 * the company's key through its `HarnessAgent` adapter, in the app's process, on Anthropic's
 * model and key: the Anthropic connector's, which the config installs beside this one.
 */
export const piAgent: CodingAgent = {
  own: {
    packages: ["pi-acp@0.0.34", "@earendil-works/pi-coding-agent@1.4.0"],
    bin: "pi-acp",
    args: [],
    // Its terminal method (`pi-acp --terminal-login`) starts pi's interactive terminal UI, which prints nothing to a pipe.
    signIn: { once: { bin: "pi", args: [], after: "/login" } },
    // A Claude plan's token refresh and model, and a ChatGPT plan's (its own sign-ins'
    // hosts, pi-ai's dist/auth/oauth): Pi publishes no network list.
    hosts: ["api.anthropic.com", "platform.claude.com", "auth.openai.com", "chatgpt.com"],
  },
  onKey: {
    model: "anthropic",
    baseUrl: "ANTHROPIC_BASE_URL",
    qualified: true,
    bridge: false,
    // Pi itself runs in the app's process, so the box reaches no host of its.
    hosts: [],
    harness: async (auth, home) => {
      const { createPi }: typeof import("@ai-sdk/harness-pi") = await import(/* @vite-ignore */ ADAPTER);
      // Pi's own settings under the session's home, not this user's ~/.pi.
      return createPi({ auth, agentDir: join(home, ".pi", "agent") });
    },
  },
};
