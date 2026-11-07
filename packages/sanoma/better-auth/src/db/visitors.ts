import { loginTables } from "./tables.ts";

/** The visitor login's tables, in the schema `better_auth`; its migrations are `drizzle/visitors/`. */
export const { schema, user, session, account, verification, rateLimit } = loginTables("better_auth");
