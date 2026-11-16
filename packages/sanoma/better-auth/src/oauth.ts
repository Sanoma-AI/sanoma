import { createCimdClientDiscovery } from "@better-auth/cimd";
import { type ClientMetadataResourceFetch, getOAuthProviderState, oauthProvider } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins/jwt";
import { CONSENT_PAGE, LOGIN_PAGE } from "sanoma/workflows";

// The staff login as an OAuth 2.1 authorization server for the agent surface (`/mcp`), whose
// resource server is the app: Better Auth's oauth-provider, its JWT plugin (the access tokens
// are JWTs, signed with keys kept in the schema's `jwks` table, so an instance per request on a
// Worker signs with the keys every other one does) and the Client ID Metadata Document discovery
// of `@better-auth/cimd` (a client is the HTTPS URL of its metadata document, as Claude Code's
// is). No dynamic client registration: a client is admitted only as the declared agent that
// stands for it.

/** The scopes there are: none of the policy's, which decides each call, so only a refresh token's. */
const SCOPES = ["offline_access"];

export interface OAuthSetup {
  /** The declared agent that stands for an OAuth client (`agentOfClient`), by its id; undefined for one no agent does. */
  agentOf(client: string): string | undefined | Promise<string | undefined>;
  /** How a client's metadata document is fetched (`fetchClientMetadataResource`); only a declared client's ever is. */
  fetchClientMetadata: ClientMetadataResourceFetch;
}

/**
 * The plugins, in the order Better Auth takes them: made once per login, never per request, so
 * the provider's own memos and the CIMD discovery's document cache hold across the instances made
 * for each pool and protocol (on a Worker, one per request). The CIMD discovery is the provider's
 * own extension, not the `cimd()` plugin: that plugin registers it on each instance's start with
 * an object of its own, which the provider's shared options then refuse the second time.
 */
export function oauthPlugins({ agentOf, fetchClientMetadata }: OAuthSetup) {
  const cimd = createCimdClientDiscovery({
    fetchClientMetadataResource: fetchClientMetadata,
    metadataProfile: "mcp-2026-07-28",
  });
  // The one gate: the provider finds every client, at every route, through its discovery's
  // `resolve` (its `getClient`, which awaits it and takes null as no such client; `matches` it
  // does not await). A client is one only while a declared agent stands for it, as the files say
  // at that request: no other's document is ever fetched (the URL is the company's choice, never
  // a caller's), and one undeclared since is no client at the token endpoint, consent or
  // revocation either. And no client is bound to DPoP, whatever its own document asks
  // (`dpop_bound_access_tokens`): the provider would demand a proof `handle` drops.
  const discovery: typeof cimd = {
    ...cimd,
    async resolve(ctx, clientId, existing) {
      if ((await agentOf(clientId)) === undefined) return null;
      const client = await cimd.resolve(ctx, clientId, existing);
      return client && { ...client, dpopBoundAccessTokens: false };
    },
  };
  return [
    // The access tokens' keys, in the `jwks` table; no JWT on a session's responses.
    jwt({ disableSettingJwtHeader: true }),
    oauthProvider({
      loginPage: LOGIN_PAGE,
      consentPage: CONSENT_PAGE,
      scopes: SCOPES,
      grantTypes: ["authorization_code", "refresh_token"],
      // The resource is this instance's own `/mcp` on the host asked (`ensureResource` in
      // staff.ts), one row per host, every one this instance's: a client is not linked to each.
      enforcePerClientResources: false,
      extensions: [{ clientDiscovery: discovery }],
      // A consent is to let a client act as the agent the consent page named: kept by that agent
      // (the consent's reference), so a client the files map to another agent since is asked
      // again, and one mapped back finds its consent. Only for that: no page after the sign-in.
      postLogin: {
        page: LOGIN_PAGE,
        shouldRedirect: () => false,
        consentReferenceId: async () => consentReference(agentOf, await getOAuthProviderState()),
      },
    }),
  ];
}

/**
 * What a consent is kept by, from the authorization request the provider holds for this request
 * (authorize's own query, or the signed one a sign-in or the consent posts): `agent:<id>`, the
 * agent its client stands for now. A client no agent stands for is none the provider finds
 * (`oauthPlugins`' gate); should one get here all the same (the files changed under the request),
 * its reference is one no consent has, so it is never let through on an earlier one.
 */
async function consentReference(agentOf: OAuthSetup["agentOf"], state: { query?: string } | null): Promise<string> {
  const client = new URLSearchParams(state?.query ?? "").get("client_id") ?? "";
  const agent = await agentOf(client);
  return agent === undefined ? `undeclared:${client}` : `agent:${agent}`;
}

/**
 * The fetch for a client's metadata document wherever the app runs (the Worker's, whose `fetch`
 * cannot resolve a name once and pin its address): `fetch` with redirects refused, so a declared
 * document cannot send it on to another address. The plugin caps it at 5 KB and 5 seconds, and
 * refuses a URL naming a private or reserved address; what is left, a declared name that
 * resolves to one, is the company's own declaration. On Node, `sanoma serve` passes
 * `@better-auth/cimd/node`'s instead, which also refuses such an address and pins it.
 */
export const declaredMetadataFetch =
  (fetcher: typeof fetch = fetch): ClientMetadataResourceFetch =>
  async (input, init) => {
    const response = await fetcher(input, { ...init, redirect: "manual" });
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400) ||
      response.type === "opaqueredirect"
    ) {
      await response.body?.cancel();
      throw new TypeError("A client's metadata document redirects, which is refused");
    }
    return response;
  };
