import { defineFake, type FakeOptions } from "@sanoma-ai/workflows/fake";
import { agent37Ops } from "./connector.ts";
import { instanceOperations } from "./operations.ts";

/** An Agent37 that holds no instances: the instance type's operations answer as for a key that works. */
export function fakeAgent37(options: FakeOptions = {}) {
  return defineFake(agent37Ops, { initial: () => ({}), ops: () => instanceOperations(async () => []) }, options);
}
