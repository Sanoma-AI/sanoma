import { defineConfig } from "sanoma";

// A company with two apps, crm (taken from a source) and shop (its own), which both declare a
// collection named customers, and a workflow of its own between them. Nothing lists the
// workflows: the launcher finds them in workflows/ and apps/<app>/workflows/.
export default defineConfig({
  connectors: [],
});
