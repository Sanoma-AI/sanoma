import { github } from "@sanoma/connector-github/resources";
import { docs } from "./github.ts";

// A rule on a repository another data file declares: the import is the reference.

export const docsMain = github.branch_protection({
  repository_id: docs,
  pattern: "main",
  allows_force_pushes: false,
});

export default [docsMain];
