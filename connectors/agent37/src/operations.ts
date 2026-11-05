import type { PlanAction } from "@sanoma-ai/workflows";
import { wanted } from "./connector.ts";

// The instance type's operations, a declaration's record: apply makes nothing at Agent37, since a
// box is made when someone first opens it. The driver's list instances with the key, so a read
// says whether it works; the fake's answer at once. Both go through `instanceOperations`.

/** What a declaration is bound by: there is no object at Agent37 to name it. */
const BINDING = "agent37";

/** A declaration's state: its binding, and that the key lists the workspace's instances. */
const stateOf = (id: string) => ({ id, healthy: true });

/** The instance type's operations, `list` the call that proves the key (it throws when it does not). */
export function instanceOperations(list: () => Promise<unknown>) {
  const read = async ({ id }: { id: string }) => {
    await list();
    return { id, gone: false, state: stateOf(id) };
  };
  /** Binds a declaration: a new one by `BINDING`, a bound one by its id. */
  const bind = async ({ id = BINDING, desired }: { id?: string; desired: Record<string, unknown> }) => {
    wanted(desired);
    await list();
    return { id, state: stateOf(id) };
  };
  return {
    instance: {
      read,
      import: read,
      plan: async ({
        id,
        desired,
      }: {
        id?: string;
        desired?: Record<string, unknown>;
      }): Promise<{ action: PlanAction; planned?: Record<string, unknown>; unknown: string[]; replace: string[] }> => {
        if (!desired) return { action: id === undefined ? "none" : "delete", unknown: [], replace: [] };
        wanted(desired);
        if (id !== undefined)
          return { action: "none", planned: { ...desired, ...stateOf(id) }, unknown: [], replace: [] };
        return {
          action: "create",
          planned: { ...desired, id: null, healthy: null },
          unknown: ["id", "healthy"],
          replace: [],
        };
      },
      create: bind,
      update: bind,
      // The boxes stay: each is discarded on its own (`SandboxBackend.discard`).
      delete: async ({ id }: { id: string }) => ({ id, gone: true as const }),
    },
  };
}
