import { loginTables } from "./tables.ts";

/** The staff login's tables, in the schema `better_auth_staff`; its migrations are `drizzle/staff/`. */
export const { schema, user, session, account, verification, rateLimit } = loginTables("better_auth_staff");
