import { betterAuth } from "@sanoma-ai/connector-better-auth";
import { defineConfig } from "sanoma";
import hello from "./workflows/hello.ts";

/** A company with one public site, sites/account, whose visitors sign in with Better Auth. */
export default defineConfig({
  workflows: [hello],
  connectors: [betterAuth],
});
