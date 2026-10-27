// Never put credentials in this file or anywhere in this repo. The drivers read theirs from the
// environment or from the app's connector pages (see .env.example). The workflows are found:
// every file of workflows/ and of each app's apps/<app>/workflows/.
import { ghost } from "@sanoma-ai/connector-ghost";
import { defineConfig } from "sanoma";

export default defineConfig({
  connectors: [ghost],
});
