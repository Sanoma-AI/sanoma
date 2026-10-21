import { z } from "zod";
import { defineWorkflow, type WorkflowDefinition } from "./define.ts";
import { isDirect } from "./direct.ts";
import type { Op } from "./op.ts";
import type { CALL_WORKFLOW } from "./shared.ts";

export { CALL_WORKFLOW } from "./shared.ts";

// The built-in `call` workflow: one operation that may be called directly (`isDirect`), as a run.
// `SanomaClient.call` starts it, as the person, when the policy holds a direct call for an
// approval, so the approval reaches the Inbox like any run's. It is a workflow like any other,
// held to the same lint: the call goes through `ctx`, under the policy, in the ledger.

/** The call workflow's input: the operation's id, and its input. */
export const CallInput = z.object({ op: z.string(), input: z.unknown() });

/**
 * The call workflow for a config: it `uses` every operation that may be called directly and has
 * a driver; `resolveConfig` adds it when there is one. A run calls `input.op` with `input.input`,
 * and returns its output; inside it the call is made as the person who started the run, so a
 * collection's save records them as `updatedBy`.
 */
export function callWorkflow(
  ops: ReadonlyMap<string, Op>,
  drivers: ReadonlyMap<string, unknown>,
  types: ReadonlyMap<string, unknown>,
): WorkflowDefinition<readonly Op[], typeof CallInput> {
  const uses = [...ops.values()]
    .filter((op) => isDirect(op, types) && drivers.has(op.id))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  return defineWorkflow({
    // The literal, held to the one name: the outline finds a workflow by a string, or a const of its own file.
    name: "call" satisfies typeof CALL_WORKFLOW,
    title: "Call an operation",
    trigger: "manual",
    input: CallInput,
    uses,
    // `ctx` refuses an operation that is not in `uses`: one that may not be called directly, or has no driver.
    run: async (ctx, input) => {
      const [vendor = "", resource = "", name = ""] = input.op.split(".");
      return ctx[vendor]![resource]![name]!(input.input);
    },
  });
}
