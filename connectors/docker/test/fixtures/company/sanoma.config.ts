// The company the host check runs in the container: the conformance kit's workflows and its
// credential probe, as `@sanoma-ai/testing/host` has them (`hostCheckWorkflows`, `hostCheck`),
// without the testing package. The kit's client starts them by name; DBOS__APPVERSION, set on
// both sides, makes their versions agree.
import { defineConfig } from "sanoma";
import { hostCheck, hostCheckWorkflows } from "./workflows/host-check.ts";

export default defineConfig({
  workflows: [...hostCheckWorkflows],
  connectors: [hostCheck],
});
