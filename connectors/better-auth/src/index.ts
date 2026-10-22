import { withSetup } from "@sanoma-ai/workflows";
import { betterAuthDriver, betterAuthOps } from "./connector.ts";
import { betterAuthLogin } from "./login.ts";

export { betterAuthLogin } from "./login.ts";

/**
 * Better Auth, a visitor login for public sites (`defineSite({ public: true, login: "better-auth" })`):
 * email and password, its users in schema `better_auth` on the company's database, its routes
 * under `/auth/better-auth/`. No operations; the driver declares `BETTER_AUTH_SECRET`.
 */
export const betterAuth = withSetup(betterAuthOps, { driver: () => betterAuthDriver, login: betterAuthLogin });
