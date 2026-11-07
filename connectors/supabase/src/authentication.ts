import {
  AuthenticationError,
  type AuthenticationIdentity,
  defineAuthentication,
  type OAuthAuthentication,
  type StoredAuthentication,
} from "@sanoma-ai/workflows";
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
 * carries an expiry (`expires_in`, which Supabase's API reference requires but does not fix), and
 * the runtime renews it with its refresh token before then, and when the Management API answers
 * 401 (Supabase's guide: "handle HTTP Unauthorized errors"). Revoke asks Supabase to end the
 * application's authorization and its tokens (`POST /v1/oauth/revoke`, JSON, not RFC 7009's form).
 */
export const supabaseOAuth: OAuthAuthentication = defineAuthentication({
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
    tokenRejected: [401],
    // No `refreshTokenLifetime`: Supabase publishes none (2026-11-06), so a grant renews on use only.
  },
  async verify(grant) {
    const identity = await organizationsOf(grant.accessToken);
    return grant.expiresAt === undefined ? identity : { ...identity, expiresAt: grant.expiresAt };
  },
  async revoke(grant, client) {
    if (!grant.refreshToken) throw new AuthenticationError("unsupported");
    const res = await fetch(`${API}/v1/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: grant.refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new AuthenticationError(res.status === 401 || res.status === 403 ? "rejected" : "unavailable");
  },
});

const accessTokenBundle = z.object({
  accessToken: z
    .string()
    .min(1)
    .describe("A personal access token from supabase.com/dashboard/account/tokens that can manage the projects"),
});

/** A personal access token, pasted on the connector page: its user's organizations are the account. */
export const supabaseAccessToken: StoredAuthentication<typeof accessTokenBundle> = defineAuthentication({
  kind: "api-key",
  version: 1,
  schema: accessTokenBundle,
  storage: { writable: false, conditionalWrites: false, maxBytes: 8192 },
  verify: ({ accessToken }) => organizationsOf(accessToken),
});
