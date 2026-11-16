import { withSetup } from "sanoma/workflows";
import { betterAuthOps } from "./connector.ts";
import { prepareBetterAuth } from "./instance.ts";
import { betterAuthLogin } from "./login.ts";

export { prepareBetterAuth, prepareBetterAuthStaff } from "./instance.ts";
export { betterAuthLogin } from "./login.ts";
export { declaredMetadataFetch } from "./oauth.ts";
export { betterAuthStaffLogin, type StaffLoginOptions } from "./staff.ts";

/**
 * Better Auth, a visitor login for public sites (`defineSite({ public: true, login: "better-auth" })`):
 * email and password, and an email code when the config names a sender, its users in schema
 * `better_auth` on the company's database, its routes under `/auth/better-auth/`, its cookies
 * signed with the key the app derives for it. The staff login is `betterAuthStaffLogin`, which the
 * `sanoma` launcher runs on a host, and which is the agent surface's authorization server there;
 * `declaredMetadataFetch` is its default fetch for a client's metadata document.
 */
export const betterAuth = withSetup(betterAuthOps, { prepare: prepareBetterAuth, login: betterAuthLogin });
