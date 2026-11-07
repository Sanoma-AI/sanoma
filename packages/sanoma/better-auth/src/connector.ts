import { defineConnector, vendorInfo } from "sanoma/workflows";

/** Better Auth: no operations, no driver and no credential; its login half is in `login.ts`. */
export const betterAuthOps = defineConnector("better-auth", {}, vendorInfo(import.meta.url));
