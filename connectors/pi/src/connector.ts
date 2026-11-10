import { defineConnector, vendorInfo } from "sanoma/workflows";

/** Pi: no operations. The coding agent is its agent part (`agent.ts`). */
export const piOps = defineConnector("pi", {}, vendorInfo(import.meta.url));
