import { Client } from "pg";

// What the staff login's tests share: Claude Code's client as a stand-in serves it, a session's
// cookie, and the staff schema as the worker first finds it.

/** Claude Code's published client id: the URL of its metadata document. */
export const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";

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
 * The test database with no staff schema and no journal of it, as the worker first finds one:
 * the database made when missing, `better_auth_staff` and its journal table dropped.
 */
export async function resetStaffSchema(databaseUrl: string): Promise<void> {
  const admin = new Client({ connectionString: Object.assign(new URL(databaseUrl), { pathname: "/postgres" }).href });
  await admin.connect();
  const name = new URL(databaseUrl).pathname.slice(1);
  const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (!rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS better_auth_staff CASCADE");
  await client.query("DROP TABLE IF EXISTS drizzle.__drizzle_migrations_better_auth_staff");
  await client.end();
}
