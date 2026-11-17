import { createCimdClientDiscovery } from "@better-auth/cimd";
import { type ClientMetadataResourceFetch, getOAuthProviderState, oauthProvider } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins/jwt";
import { type AgentAddress, CONSENT_PAGE, LOGIN_PAGE } from "sanoma/workflows";

// The staff login as an OAuth 2.1 authorization server for the agent surface (`/mcp`), whose
// resource server is the app: Better Auth's oauth-provider, its JWT plugin (the access tokens
// are JWTs, signed with keys kept in the schema's `jwks` table, so an instance per request on a
// Worker signs with the keys every other one does, as the one configured issuer, for the one
// configured resource: the instance's agent address) and the Client ID Metadata Document discovery
// of `@better-auth/cimd` (a client is the HTTPS URL of its metadata document, as Claude Code's
// is). No dynamic client registration: a client is admitted only as the declared agent that
// stands for it.

/** The scopes there are: none of the policy's, which decides each call, so only a refresh token's. */
const SCOPES = ["offline_access"];

/**
 * The access token's claim naming the agent its person consented to (`holding`): a token is that
 * agent's alone, whichever agent its client (`azp`) stands for since.
 */
export const AGENT_CLAIM = "sanoma_agent";

/** What a consent, and each code and refresh token it leads to, is kept by (their `referenceId`): the agent consented to. */
const referenceOf = (agent: string) => `agent:${agent}`;

export interface OAuthSetup {
  /** The declared agent that stands for an OAuth client (`agentOfClient`), by its id; undefined for one no agent does. */
  agentOf(client: string): string | undefined | Promise<string | undefined>;
  /** How a client's metadata document is fetched (`fetchClientMetadataResource`); only a declared client's ever is. */
  fetchClientMetadata: ClientMetadataResourceFetch;
  /**
   * The instance's agent address (`LoginContext.staff.oauth.address`): the issuer every token and
   * the metadata name, and the one resource a token is issued for. Without one nothing is issued:
   * the provider has no resource, and the login serves none of its routes.
   */
  address?: AgentAddress;
}

/** The CIMD discovery, as the provider takes one. */
type Discovery = ReturnType<typeof createCimdClientDiscovery>;

/**
 * How long a client's resolution is waited for: the plugin caps the document's fetch at 5
 * seconds, and writes the client's row after.
 */
const RESOLVE_WAIT_MS = 10_000;

/** A resolution that did not settle in `RESOLVE_WAIT_MS`. */
const LATE = Symbol("late");

/**
 * The plugins, in the order Better Auth takes them: made once per login, never per request, so
 * the provider's own memos and the CIMD discovery's document cache hold across the instances made
 * for each pool and protocol (on a Worker, one per request). The CIMD discovery is the provider's
 * own extension, not the `cimd()` plugin: that plugin registers it on each instance's start with
 * an object of its own, which the provider's shared options then refuse the second time.
 */
export function oauthPlugins({ agentOf, fetchClientMetadata, address }: OAuthSetup) {
  const make = () =>
    createCimdClientDiscovery({
      fetchClientMetadataResource: fetchClientMetadata,
      metadataProfile: "mcp-2026-07-28",
    });
  /** The discovery every request resolves with, until one of its resolutions never settles. */
  let cimd = make();
  /**
   * A client as `cimd` resolves it, waited for no longer than `RESOLVE_WAIT_MS`. The discovery
   * keeps each client's resolution under way and hands it to whoever asks next, with no bound,
   * and it is shared by every request; a request a Worker cancels never settles its own (its
   * timers and continuations do not run again), so every later one for that client would wait
   * for ever. One not settled in time is given up with the discovery that holds it (its cache
   * and its counts of fetches under way too), and this request and those after resolve with a
   * new one; a second that does not settle either fails the request.
   */
  const resolved: Discovery["resolve"] = async (ctx, clientId, existing) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const asked = cimd;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<typeof LATE>((resolve) => (timer = setTimeout(() => resolve(LATE), RESOLVE_WAIT_MS)));
      try {
        const client = await Promise.race([asked.resolve(ctx, clientId, existing), late]);
        if (client !== LATE) return client;
      } finally {
        clearTimeout(timer);
      }
      if (cimd === asked) cimd = make();
    }
    throw new Error(`better-auth: the client ${clientId} was not resolved in time`);
  };
  // The one gate: the provider finds every client, at every route, through its discovery's
  // `resolve` (its `getClient`, which awaits it and takes null as no such client; `matches` it
  // does not await). A client is one only while a declared agent stands for it, as the files say
  // at that request: no other's document is ever fetched (the URL is the company's choice, never
  // a caller's), and one undeclared since is no client at the token endpoint, consent or
  // revocation either. And no client is bound to DPoP, whatever its own document asks
  // (`dpop_bound_access_tokens`): the provider would demand a proof `handle` drops.
  const discovery: Discovery = {
    ...cimd,
    async resolve(ctx, clientId, existing) {
      if ((await agentOf(clientId)) === undefined) return null;
      const client = await resolved(ctx, clientId, existing);
      return client && { ...client, dpopBoundAccessTokens: false };
    },
  };
  return [
    // The access tokens' keys, in the `jwks` table; no JWT on a session's responses. Its issuer
    // is the one setting the provider reads for an access token's `iss`, the `iss` of authorize's
    // redirect back (RFC 9207) and its metadata's `issuer`: the configured one, so none of them
    // is a request's host (unset, each would be the base URL, which is the request's).
    jwt({ disableSettingJwtHeader: true, ...(address && { jwt: { issuer: address.issuer } }) }),
    oauthProvider({
      loginPage: LOGIN_PAGE,
      consentPage: CONSENT_PAGE,
      scopes: SCOPES,
      grantTypes: ["authorization_code", "refresh_token"],
      // The one resource is the configured address's, its row the provider's own seed
      // (`seedResourcesOnce`, at each instance's start: a read, an insert only when the row is
      // missing), never made for a request: the provider issues a token only for a resource it
      // has a row for, and compares none with the request's host. It is the instance's, for
      // every declared client: a client is not linked to it.
      ...(address && { resources: [{ identifier: address.resource, name: "Agent surface" }] }),
      enforcePerClientResources: false,
      extensions: [{ clientDiscovery: discovery, claims: { accessToken: holding(agentOf) } }],
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
  return agent === undefined ? `undeclared:${client}` : referenceOf(agent);
}

/**
 * What every access token says besides the provider's own claims, asked by the provider before it
 * issues one (a code's, or a refresh's, before the refresh token is rotated): the agent it is for
 * (`AGENT_CLAIM`), which is the one the person consented to. The code and the refresh token carry
 * that consent's reference; when it is not the agent their client stands for now (the files moved
 * the client to another agent since), nothing is issued: `invalid_grant`, and the client signs in
 * again, where the person is asked about the new agent. Nothing is used up, so a client mapped
 * back refreshes as before.
 */
const holding =
  (agentOf: OAuthSetup["agentOf"]) =>
  async ({ client, referenceId }: { client: { clientId: string }; referenceId?: string }) => {
    const agent = await agentOf(client.clientId);
    if (agent === undefined || referenceId !== referenceOf(agent)) {
      throw new APIError("BAD_REQUEST", {
        error: "invalid_grant",
        error_description: "The person consented to another agent than the one this client stands for now",
      });
    }
    return { [AGENT_CLAIM]: agent };
  };

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
