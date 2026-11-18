import { SanomaError } from "./errors.ts";
import { isOperation, type Op } from "./op.ts";
import { isResourceOp } from "./resource.ts";
import { APPS_LIST, DATA_VENDOR, OPERATIONS_VENDOR, STORE_MOVE_DIRECT } from "./shared.ts";

/**
 * Whether an operation may be called directly, outside a run (`SanomaClient.call`), as the
 * person: a company operation (the vendor `operations`) whose every used operation may be, a
 * collection's (`data.<name>.<op>`), the runtime's listing of apps (`sanoma.apps.list`,
 * which a page calls), run inspection, connection management, a secret store move's plan and its cancel, or a `read` that is neither the runtime's own (the vendor `sanoma`),
 * a company operation (by its uses alone) nor a resource type's (`isResourceOp`), which only drift and apply call.
 * Anything else (an effect at a vendor, or a company operation that makes one) is a workflow's. The one rule: the built-in `call`
 * workflow, the SDK and the app read it, from here or from `OpEntry.direct`, and never derive it.
 */
export const isDirect = (
  op: Pick<Op, "id" | "vendor" | "resource" | "effect">,
  types: ReadonlyMap<string, unknown>,
): boolean =>
  (isOperation(op) && workflowOnlyUses(op, types).length === 0) ||
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
  (op.effect === "read" && op.vendor !== "sanoma" && op.vendor !== OPERATIONS_VENDOR && !isResourceOp(op, types));

/**
 * What keeps an operation from a page: for a company operation, the operations it uses that may
 * not be called directly (`isDirect`), in the order declared; none for another operation.
 */
export const workflowOnlyUses = (op: Pick<Op, "id">, types: ReadonlyMap<string, unknown>): Op[] =>
  isOperation(op) ? op.uses.filter((u) => !isDirect(u, types)) : [];

/**
 * The end of what refuses a company operation a page, after its id, naming the operations it uses
 * that keep it from one: the runtime's refusal (`notDirect`) and `sanoma check`'s (`readSites`).
 */
export const callsWorkflowOnly = (ids: readonly string[]) =>
  `, since it calls ${ids.join(", ")}: start a workflow that uses it`;

/**
 * Why `id` may not be called directly, as `SanomaClient.call` and a page's transport refuse it
 * (`invalid_input`): no operation has it, a company operation calls what keeps it from a page
 * (`workflowOnlyUses`), or it is a workflow's to call.
 */
export function notDirect(id: string, op: Op | undefined, types: ReadonlyMap<string, unknown>): SanomaError {
  const held = op ? workflowOnlyUses(op, types).map((u) => u.id) : [];
  const why = !op
    ? ": no connector or collection declares it"
    : held.length > 0
      ? callsWorkflowOnly(held)
      : ": it is a workflow's to call: start one that uses it";
  return new SanomaError("invalid_input", `${id} cannot be called directly${why}`, { op: id });
}
