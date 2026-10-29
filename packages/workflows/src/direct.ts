import type { Op } from "./op.ts";
import { isResourceOp } from "./resource.ts";
import { APPS_LIST, DATA_VENDOR } from "./shared.ts";

/**
 * Whether an operation may be called directly, outside a run (`SanomaClient.call`), as the
 * person: a collection's (`data.<name>.<op>`), the runtime's listing of apps (`sanoma.apps.list`,
 * which a page calls), or a `read` that is neither the runtime's own (the vendor `sanoma`) nor a
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
  op.id === "sanoma.connection.disconnect" ||
  op.id === "sanoma.connection.bind" ||
  op.id === "sanoma.connection.create" ||
  op.id === "sanoma.connection.prepare" ||
  op.id === "sanoma.connection.configure" ||
  op.id === "sanoma.connection.activate" ||
  op.id === "sanoma.connection.test" ||
  (op.effect === "read" && op.vendor !== "sanoma" && !isResourceOp(op, types));
