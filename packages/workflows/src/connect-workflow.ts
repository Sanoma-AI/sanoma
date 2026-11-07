import { z } from "zod";
import { connectionOps, connectionTargetSchema } from "./connection.ts";
import { defineWorkflow, type WorkflowDefinition } from "./define.ts";
import type { CONNECT_WORKFLOW } from "./shared.ts";

// The built-in `connect` workflow: an OAuth connection's exchange, once its provider sent the
// person back with a code. The app's callback seals the code into the attempt's row and starts
// the run as that person (`SanomaClient.receiveConnection`), given the attempt's id alone; the
// exchange (`sanoma.connection.exchange`, which only this workflow calls) takes the code inside
// its driver and stores the grant, and activation verifies what was stored. Both are policy
// decisions in the ledger; neither's input or output carries a code, verifier or token. A
// workflow like any other, held to the same lint.

/** What the callback starts it with: the connection's setup target, its request, and the attempt's opaque id. */
const ConnectInput = z.object({
  target: connectionTargetSchema,
  requestId: z.string().min(1),
  attempt: z.string().min(1),
});

/**
 * Defined when a config needs it, never as the module loads: a bundle evaluated on workerd has
 * no file to read a workflow's outline from.
 */
export function connectWorkflow(): WorkflowDefinition<any, any> {
  return defineWorkflow({
    // The literal, held to the one name: the outline finds a workflow by a string, or a const of its own file.
    name: "connect" satisfies typeof CONNECT_WORKFLOW,
    title: "Connect an account",
    trigger: "manual",
    input: ConnectInput,
    uses: [connectionOps.connection.exchange, connectionOps.connection.activate],
    run: async (ctx, input) => {
      const exchanged = await ctx.sanoma.connection.exchange(input);
      return ctx.sanoma.connection.activate({ connection: exchanged.connection, expectedRevision: exchanged.revision });
    },
  });
}
