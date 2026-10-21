import { defineConfig } from "sanoma";
import hello from "./workflows/hello.ts";

/** A company with one site, sites/hello, and no connectors. */
export default defineConfig({
  workflows: [hello],
  connectors: [],
});
