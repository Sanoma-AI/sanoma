import { withSetup } from "@sanoma-ai/workflows";
import { betterAuthOps } from "./connector.ts";
import { betterAuthLogin } from "./login.ts";

export { betterAuthLogin } from "./login.ts";
export { betterAuthStaffLogin } from "./staff.ts";

/**
 * Better Auth, a visitor login for public sites (`defineSite({ public: true, login: "better-auth" })`):
 * email and password, and an email code when the config names a sender, its users in schema
 * `better_auth` on the company's database, its routes under `/auth/better-auth/`, its cookies
 * signed with the key the app derives for it. The staff login is `betterAuthStaffLogin`, which the
 * `sanoma` launcher runs on a host.
 */
export const betterAuth = withSetup(betterAuthOps, { login: betterAuthLogin });
