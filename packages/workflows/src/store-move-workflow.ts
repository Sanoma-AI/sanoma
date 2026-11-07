import { z } from "zod";
import { defineWorkflow, type WorkflowDefinition } from "./define.ts";
import type { MIGRATE_STORE_WORKFLOW } from "./shared.ts";
import { Names, StoreName, storeMoveOps } from "./store-move.ts";

// The built-in `migrate-store` workflow: a move of the company's secrets from the selected store
// to one in `secrets.stores`, its operations in order (`store-move.ts`), each a policy decision
// in the ledger. Its run's id is the move's. It waits, checking the copies again, until the
// deployed code selects the destination (the reviewed change that switches `secrets`), cuts
// over, waits out the rollback window and retires the source's copies. A stop anywhere resumes
// where it was: every operation is idempotent and reads the move's receipts. A workflow like any
// other, held to the same lint.

/** What the app starts a move with: the destination's name in `secrets.stores`, any names Sanoma would not find itself, and the rollback window. */
export const MigrateStoreInput = z.object({
  to: StoreName,
  names: Names,
  retainHours: z
    .number()
    .int()
    .min(0)
    .max(24 * 366)
    .default(24 * 7),
});
export type MigrateStoreInput = z.input<typeof MigrateStoreInput>;

/**
 * Defined when a config names other stores, never as the module loads: a bundle evaluated on
 * workerd has no file to read a workflow's outline from.
 */
export function migrateStoreWorkflow(): WorkflowDefinition<any, any> {
  const ops = storeMoveOps.storeMigration;
  return defineWorkflow({
    // The literal, held to the one name: the outline finds a workflow by a string, or a const of its own file.
    name: "migrate-store" satisfies typeof MIGRATE_STORE_WORKFLOW,
    title: "Move secrets to another store",
    trigger: "manual",
    input: MigrateStoreInput,
    uses: [ops.plan, ops.prepare, ops.transfer, ops.verify, ops.cutover, ops.retire, "sleep"],
    run: async (ctx, input) => {
      const move = ctx.runId;
      await ctx.sanoma.storeMigration.plan({ to: input.to, names: input.names });
      await ctx.sanoma.storeMigration.prepare({
        move,
        to: input.to,
        names: input.names,
        retainHours: input.retainHours,
      });
      await ctx.sanoma.storeMigration.transfer({ move }, { name: "Copy" });
      let checked = await ctx.sanoma.storeMigration.verify({ move }, { name: "Read back" });
      let waits = 0;
      while (checked.next === "transfer" || checked.next === "wait") {
        if (checked.next === "transfer") {
          await ctx.sanoma.storeMigration.transfer({ move }, { name: "Copy again" });
        } else {
          // Until the switch deploys: five seconds, doubling to five minutes, the most a deployed
          // switch waits for its cutover (and connections for their rebinding).
          await ctx.sleep({ seconds: Math.min(300, 5 * 2 ** Math.min(waits, 6)) }, { name: "Wait for the switch" });
          waits = waits + 1;
        }
        checked = await ctx.sanoma.storeMigration.verify({ move }, { name: "Check again" });
      }
      // One return, at the end: the outline runs top to bottom.
      let outcome: { phase: string; retired?: string[] } = { phase: "cancelled" };
      if (checked.next === "cutover") {
        const cut = await ctx.sanoma.storeMigration.cutover({ move });
        await ctx.sleep({ until: cut.retainUntil }, { name: "Rollback window" });
        const { retired } = await ctx.sanoma.storeMigration.retire({ move });
        outcome = { phase: "retired", retired };
      }
      return outcome;
    },
  });
}
