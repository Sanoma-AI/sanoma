import { connectionRefSchema, type ConnectionRef } from "./connection.ts";
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

/** An operation on `ctx`. */
type OpCall = (input: unknown, options?: { connection?: ConnectionRef }) => Promise<unknown>;

/** The call workflow's input: the operation's id, and its input. */
export const CallInput = z.object({ op: z.string(), input: z.unknown(), connection: connectionRefSchema.optional() });

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
      // Four segments for an app's collection: `data.<app>.<collection>.<op>`.
      const [vendor = "", a = "", b = "", c] = input.op.split(".");
      return c === undefined
        ? ctx[vendor]![a]![b]!(input.input, { connection: input.connection })
        : (ctx as unknown as Record<string, Record<string, Record<string, Record<string, OpCall>>>>)[vendor]![a]![b]![
            c
          ]!(input.input, { connection: input.connection });
    },
  });
}
