import type { Op } from "./op.ts";
import { isResourceOp } from "./resource.ts";
import { APPS_LIST, DATA_VENDOR, STORE_MOVE_DIRECT } from "./shared.ts";

/**
 * Whether an operation may be called directly, outside a run (`SanomaClient.call`), as the
 * person: a collection's (`data.<name>.<op>`), the runtime's listing of apps (`sanoma.apps.list`,
 * which a page calls), run inspection, connection management, a secret store move's plan and its cancel, or a `read` that is neither the runtime's own (the vendor `sanoma`) nor a
 * resource type's (`isResourceOp`), which only drift and apply call.
 * Anything else (an effect at a vendor) is a workflow's. The one rule: the built-in `call`
 * workflow, the SDK and the app read it, from here or from `OpEntry.direct`, and never derive it.
 */
export const isDirect = (
  op: Pick<Op, "id" | "vendor" | "resource" | "effect">,
  types: ReadonlyMap<string, unknown>,
): boolean =>
  op.vendor === DATA_VENDOR ||
  op.id === APPS_LIST ||
  op.id === "sanoma.run.inspect" ||
  op.id === "sanoma.connection.disconnect" ||
  op.id === "sanoma.connection.revoke" ||
  op.id === "sanoma.connection.refresh" ||
  op.id === "sanoma.connection.bind" ||
  op.id === "sanoma.connection.create" ||
  op.id === "sanoma.connection.prepare" ||
  op.id === "sanoma.connection.configure" ||
  op.id === "sanoma.connection.activate" ||
  op.id === "sanoma.connection.authorize" ||
  op.id === "sanoma.connection.test" ||
  STORE_MOVE_DIRECT.has(op.id) ||
  (op.effect === "read" && op.vendor !== "sanoma" && !isResourceOp(op, types));
