// Never put credentials in this file or anywhere in this repo. The drivers read theirs from the
// environment or from the app's connector pages (see .env.example).
import { ghost } from "@sanoma-ai/connector-ghost";
import { defineConfig } from "sanoma";
import publishPost from "./workflows/publish-post.ts";

export default defineConfig({
  workflows: [publishPost],
  connectors: [ghost],
});
