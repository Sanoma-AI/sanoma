import type { PlanAction } from "@sanoma-ai/workflows";
import { wanted } from "./connector.ts";

// The instance type's operations, a declaration's record: apply makes nothing at Agent37, since a
// box is made when someone first opens it. The driver's list instances with the key, so a read
// says whether it works; the fake's answer at once. Both go through `instanceOperations`.

/** What a declaration is bound by: there is no object at Agent37 to name it. */
export const BINDING = "agent37";

/** A declaration's state: its binding, and that the key lists the workspace's instances. */
const stateOf = (id: string) => ({ id, healthy: true });

/** The instance type's operations, `list` the call that proves the key (it throws when it does not). */
export function instanceOperations(list: () => Promise<unknown>) {
  const read = async ({ id }: { id: string }) => {
    await list();
    return { id, gone: false, state: stateOf(id) };
  };
  return {
    instance: {
      read,
      import: read,
      plan: async ({ id, desired }: { id?: string; desired?: Record<string, unknown> }) => {
        const none = { unknown: [], replace: [] };
        if (!desired) return { action: (id === undefined ? "none" : "delete") as PlanAction, ...none };
        wanted(desired);
        if (id !== undefined) return { action: "none" as PlanAction, planned: { ...desired, ...stateOf(id) }, ...none };
        const unknown = ["id", "healthy"];
        return {
          action: "create" as PlanAction,
          planned: { ...desired, id: null, healthy: null },
          unknown,
          replace: [],
        };
      },
      create: async ({ desired }: { desired: Record<string, unknown> }) => {
        wanted(desired);
        await list();
        return { id: BINDING, state: stateOf(BINDING) };
      },
      update: async ({ id, desired }: { id: string; desired: Record<string, unknown> }) => {
        wanted(desired);
        await list();
        return { id, state: stateOf(id) };
      },
      // The boxes stay: each is discarded on its own (`SandboxBackend.discard`).
      delete: async ({ id }: { id: string }) => ({ id, gone: true as const }),
    },
  };
}
