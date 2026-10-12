import { ghost } from "@sanoma/connector-ghost";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
import { defineConfig, memoryLedger } from "sanoma";
import policy from "./policies/policy.ts";
import hello from "./workflows/hello.ts";

// A small company repo, for the bin's tests: one workflow on Ghost, run on the fake.
const blog = fakeGhost();

export default defineConfig({
  workflows: [hello],
  connectors: [ghost],
  drivers: [blog.driver],
  fakes: [blog],
  scenarios: new URL("./scenarios/", import.meta.url),
  policy,
  ledger: memoryLedger(),
  appName: "sanoma-fixture",
});
