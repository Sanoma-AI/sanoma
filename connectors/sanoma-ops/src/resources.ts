import { wakeup } from "./connector.ts";

/**
 * The constructor a data file declares the wakeup with, for the host it names:
 * `export const wakeup = sanomaOps.wakeup({ host })`.
 */
export const sanomaOps = { wakeup };
