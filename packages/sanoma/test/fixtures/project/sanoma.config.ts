import { ghost } from "@sanoma-ai/connector-ghost";
import { defineConfig } from "sanoma";
import policy from "./policies/policy.ts";
import hello from "./workflows/hello.ts";

export default defineConfig({
  workflows: [hello],
  connectors: [ghost],
  policy,
});
