import { defineSteps } from "@sanoma-ai/workflows";
import { neonOps } from "./connector.ts";

const { create } = neonOps.project;
const branch = neonOps.branch.create;

/**
 * Neon's steps for Gherkin tests: a project at Neon before the run (named `project`, so an
 * operation's own test can use `$project.id`), and a branch the run made, by its name.
 */
export const neonSteps = defineSteps("neon", ({ given, then }) => {
  given("a Neon project {string} in {string}", (name: string, region: string) => ({
    op: create,
    input: { desired: { name, region } },
    as: "project",
  }));
  then("a Neon branch {string} was created", (name: string) => ({
    op: branch,
    called: true,
    check: (run) => {
      const names = run.calls(branch).map((c) => c.input.name);
      if (names.includes(name)) return undefined;
      return `no Neon branch ${name} was created${names.length ? ` (only ${names.join(", ")})` : ""}`;
    },
  }));
});
