import { AuthenticationError, type AuthenticationIdentity, defineAuthentication } from "@sanoma-ai/workflows";
import { z } from "zod";

/** Supabase's Management API, which both methods' tokens call. */
export const API = "https://api.supabase.com";

/**
 * The account a token authorizes, from Supabase: the organizations `GET /v1/organizations`
 * lists, by id, sorted and joined with commas. An OAuth grant reaches the one organization the
 * person chose at consent; a personal access token every organization of its user. Supabase
 * attests no scopes to either, so none are claimed.
 */
async function organizationsOf(token: string): Promise<AuthenticationIdentity> {
  const res = await fetch(`${API}/v1/organizations`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401 || res.status === 403) throw new AuthenticationError("rejected");
  if (!res.ok) throw new AuthenticationError("unavailable");
  const organizations = (await res.json()) as { id?: unknown }[];
  const ids = Array.isArray(organizations)
    ? organizations.map((o) => o?.id).filter((id) => typeof id === "string")
    : [];
  if (!ids.length) throw new AuthenticationError("rejected");
  return { account: ids.toSorted().join(","), scopes: [] };
}

/**
 * Supabase's OAuth (Management API, authorization code with PKCE): the company registers its
 * own OAuth application in its Supabase organization (Settings, OAuth Apps) with the redirect URI
 * `<app origin>/connect/supabase/callback`, and enters its client ID and secret on the connector
 * page. Supabase takes scopes from the application, not the request, so none are sent. The grant
 * carries an expiry; until renewal is wired (sanoma#467), an expired grant needs Reconnect.
 */
export const supabaseOAuth = defineAuthentication({
  kind: "oauth2",
  version: 1,
  storage: { writable: true, conditionalWrites: true, maxBytes: 16_384 },
  oauth: {
    authorizeUrl: `${API}/v1/oauth/authorize`,
    tokenUrl: `${API}/v1/oauth/token`,
    scopes: [],
    pkce: true,
    clientAuthentication: "client_secret_basic",
    refresh: "refresh_token",
  },
  async verify(grant) {
    const identity = await organizationsOf(grant.accessToken);
    return grant.expiresAt === undefined ? identity : { ...identity, expiresAt: grant.expiresAt };
  },
});

/** A personal access token, pasted on the connector page: its user's organizations are the account. */
export const supabaseAccessToken = defineAuthentication({
  kind: "api-key",
  version: 1,
  schema: z.object({
    accessToken: z
      .string()
      .min(1)
      .describe("A personal access token from supabase.com/dashboard/account/tokens that can manage the projects"),
  }),
  storage: { writable: false, conditionalWrites: false, maxBytes: 8192 },
  verify: ({ accessToken }) => organizationsOf(accessToken),
});
