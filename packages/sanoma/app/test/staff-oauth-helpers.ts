import { Client } from "pg";
import { BUILT_IN_CLIENTS } from "sanoma/workflows/shared";

// What the tests of a client's sign-in on a host share (`hosted-mcp.test.ts` on Node,
// `app-bundle.test.ts` on the Worker): Claude Code's client as a stand-in serves it, a session's
// cookie, and the staff login's schema afresh.

/**
 * The built-in clients' published ids, each the URL of its metadata document (`BUILT_IN_CLIENTS`):
 * `CLAUDE`, the client of Claude's hosted apps, and `CLAUDE_CODE`, Claude Code's.
 */
export const [CLAUDE, CLAUDE_CODE] = BUILT_IN_CLIENTS.map((b) => b.client) as [string, string];

/** Claude Code's document, as claude.ai serves it. */
export const CLAUDE_CODE_DOCUMENT = {
  client_id: CLAUDE_CODE,
  client_name: "Claude Code",
  redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

/** The session cookie an answer sets, as a browser sends it back; empty when it sets none. */
export const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .find((c) => c.includes("session_token="))
    ?.split(";")[0] ?? "";

/**
 * The staff login's tables gone, with their journal, for `prepareBetterAuthStaff` to make afresh:
 * a consent an earlier run gave would skip the consent page.
 */
export async function resetStaffSchema(databaseUrl: string): Promise<void> {
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  await db.query("DROP SCHEMA IF EXISTS better_auth_staff CASCADE");
  await db.query("DROP TABLE IF EXISTS drizzle.__drizzle_migrations_better_auth_staff");
  await db.end();
}
