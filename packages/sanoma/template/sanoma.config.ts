// Never put credentials in this file or anywhere in this repo. The drivers read theirs from the
// environment or from the app's connector pages (see .env.example). The workflows are found:
// every file of workflows/ and of each app's apps/<app>/workflows/. Anthropic gives the app's
// chat its model: its key goes on its connector page.
import { anthropic } from "@sanoma-ai/connector-anthropic";
import { ghost } from "@sanoma-ai/connector-ghost";
import { defineConfig } from "sanoma";

export default defineConfig({
  connectors: [anthropic, ghost],
  // Host deployment may deliver these bootstrap keys; they are never stored in the database.
  secrets: {
    bindings: {
      SANOMA_SIGNING_KEY: { bootstrap: "SANOMA_SIGNING_KEY" },
      SANOMA_SECRETS_KEY: { bootstrap: "SANOMA_SECRETS_KEY" },
    },
  },
});
