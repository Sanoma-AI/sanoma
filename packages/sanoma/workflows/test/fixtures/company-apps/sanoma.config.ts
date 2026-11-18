import { defineConfig } from "sanoma";

// A company with two apps, crm (taken from a source) and shop (its own), which both declare a
// collection named customers, and workflows of its own between them; the company and the CRM each
// have an operation of their own, which a workflow uses as steps. Nothing lists them: the launcher
// finds them in workflows/, operations/ and apps/<app>/workflows/ and apps/<app>/operations/.
export default defineConfig({
  connectors: [],
});
