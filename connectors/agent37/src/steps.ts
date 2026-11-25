import { defineSteps } from "sanoma/workflows";

/**
 * Agent37's steps for Gherkin tests: the workspace's limit of awake instances before the run, so a
 * scenario shows what a workflow does when Agent37 refuses one more (`instance_limit_reached`);
 * `0` makes every box that is not awake already busy.
 */
export const agent37Steps = defineSteps("agent37", ({ given }) => {
  given("Agent37's workspace keeps at most {int} instances awake", (instanceLimit: number) => ({
    resource: "agent37.workspace",
    name: "workspace",
    fields: { instanceLimit },
  }));
});
