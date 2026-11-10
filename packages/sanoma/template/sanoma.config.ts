// Never put credentials in this file or anywhere in this repo. The drivers read theirs from the
// environment or from the app's connector pages (see .env.example). The workflows are found:
// every file of workflows/ and of each app's apps/<app>/workflows/.
import { anthropic } from "@sanoma-ai/connector-anthropic";
import { github } from "@sanoma-ai/connector-github";
import { openai } from "@sanoma-ai/connector-openai";
import { opencode } from "@sanoma-ai/connector-opencode";
import { pi } from "@sanoma-ai/connector-pi";
import { resend } from "@sanoma-ai/connector-resend";
import { cloud } from "@sanoma-ai/connector-sanoma-cloud";
import { defineConfig } from "sanoma";
import { secrets } from "./secrets.ts";

export default defineConfig({
  // Anthropic gives the app's chat its model (its key goes on its connector page); Resend sends
  // email; GitHub holds this repository once it goes live, and Sanoma Cloud the database and the
  // host it goes live on (resources/sanoma/infra.ts). Each coding agent comes from its vendor's
  // connector: Claude Code from Anthropic's, Copilot from GitHub's, Codex from OpenAI's, and
  // OpenCode and Pi from their own.
  connectors: [anthropic, resend, github, openai, opencode, pi, cloud],
  secrets,
  // Sign-in codes go out through Resend (the built-in `login-code` workflow, as the runtime's agent
  // `login`): Sanoma's sender on a Sanoma Cloud host; on a laptop, a Resend key of your own, or none.
  login: { sender: resend.emails.send, from: "Sanoma <login@sanoma.work>" },
});
