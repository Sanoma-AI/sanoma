import { sanoma as people } from "./person.ts";
import { wakeup } from "./wakeup-type.ts";

// `@sanoma-ai/workflows/resources`: what a data file imports from the runtime: `secret`, which
// names a stored secret, and `sanoma`, the constructors of its people types (`sanoma.person`, …)
// and of its wakeup, `sanoma.wakeup({ host })`.
export { secret, type Secret } from "./secret.ts";

/** The runtime's own constructors: the people types' and the wakeup's. */
export const sanoma = { ...people, wakeup };
