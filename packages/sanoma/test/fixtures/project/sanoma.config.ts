import { ghost } from "@sanoma-ai/connector-ghost";
import { defineConfig } from "sanoma";
import hello from "./workflows/hello.ts";

export default defineConfig({
  workflows: [hello],
  connectors: [ghost],
});
