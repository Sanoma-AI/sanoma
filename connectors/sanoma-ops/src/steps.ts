import { defineSteps } from "@sanoma-ai/workflows";
import { sanomaOpsOps } from "./connector.ts";

const { create, register } = sanomaOpsOps.wakeup;

/**
 * sanoma-ops's steps for Gherkin tests: a wakeup instance at the service before the run (named
 * `wakeup`, so an operation's own test can use `$wakeup.id`), and a wake the run registered.
 */
export const sanomaOpsSteps = defineSteps("sanomaOps", ({ given, then }) => {
  given("a sanoma-ops wakeup for {string}", (host: string) => ({
    op: create,
    input: { desired: { host } },
    as: "wakeup",
  }));
  then("a sanoma-ops wake is registered with generation {int}", (generation: number) => ({
    op: register,
    called: true,
    check: (run) => {
      const seen = run.calls(register).map((c) => c.input.generation);
      if (seen.includes(generation)) return undefined;
      return `no sanoma-ops wake was registered with generation ${generation}${seen.length ? ` (only ${seen.join(", ")})` : ""}`;
    },
  }));
});
