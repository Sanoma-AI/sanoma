import { defineConnector, vendorInfo } from "sanoma/workflows";

/** OpenCode: no operations. The coding agent is its agent part (`agent.ts`). */
export const opencodeOps = defineConnector("opencode", {}, vendorInfo(import.meta.url));
