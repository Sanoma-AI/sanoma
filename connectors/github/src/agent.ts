import type { CodingAgent } from "sanoma/workflows";

/**
 * Copilot, the chat's coding agent on a person's own plan: GitHub's Copilot CLI over the Agent
 * Client Protocol (`copilot --acp`), signed in with the person's GitHub account in the chat.
 */
export const copilot: CodingAgent = {
  own: {
    packages: ["@github/copilot@1.0.103"],
    bin: "copilot",
    args: ["--acp"],
    // Its advertised method (`copilot login`) opens a browser on this machine; the device flow prints a link and a code.
    signIn: { run: ["login", "--device-code"] },
    // Its device-code sign-in, its Copilot token and the Copilot API, and the suggestion services
    // GitHub lists as required: https://docs.github.com/en/copilot/reference/copilot-allowlist-reference.
    hosts: [
      "github.com",
      "api.github.com",
      "*.githubcopilot.com",
      "copilot-proxy.githubusercontent.com",
      "origin-tracker.githubusercontent.com",
    ],
  },
};
