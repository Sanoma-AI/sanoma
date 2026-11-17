// The agents' router (`ResolvedConfig.router`, sanoma#777): one address many companies' agents
// connect to, served by this instance's app on one more hostname, ahead of every login. Stateless:
// it verifies no token, signs nothing and keeps no credential, session or cache. Each company
// behind it stays its own sign-in authority (its staff login, with a routed agent address:
// `AgentAddress.router`), and the router only finds which company a request is for and sends it
// on: by the id a person types on its authorize page, by the tag in front of an authorization
// code or a refresh token (`<company>.`), and by the `sanoma_company` claim of an access token,
// read without checking its signature: a tag only says where to send, and the company there
// checks everything. A company is found by its exact id in the list the config names (a
// collection of this instance's), never by a host a request names, so the router contacts no
// address outside that list, and only over HTTPS (`companyBase`): whoever may write that list
// says where a company's agents' traffic goes. On the Worker and on Node alike: it runs on
// `fetch` and the request's client.
import {
  AGENT_SURFACE_PATH,
  agentResourceMetadata,
  agentServerMetadata,
  bearerJws,
  CLIENT_IP_HEADER,
  COMPANY_CLAIM,
  COMPANY_ID,
  companyOfTag,
  DISCOVERY_CACHE,
  errorMessage,
  RESOURCE_METADATA,
  type ResolvedRouter,
  resourceMetadataOf,
  ROUTER_CLIENT_IP_HEADER,
  ROUTER_SECRET_HEADER,
  routerAddressOf,
  routerSecretFor,
  STAFF_AUTH_PATH,
  STAFF_OAUTH_ROUTES,
} from "sanoma/workflows";
import { bodyText, instanceUrl, isLoopback } from "sanoma/workflows/shared";
import { escapeHtml, smallPage } from "./login/page.ts";
import { challenge } from "./login/staff.ts";
import { plain } from "./server/webhooks.ts";

/** The router's own routes, on its hostname: the endpoints its metadata names, and the agent surface. */
export const ROUTER_ROUTES = { authorize: "/authorize", token: "/token", revoke: "/revoke" } as const;

/** Where RFC 8414's metadata for the router's issuer is: the well-known path alone, the issuer having no path. */
const SERVER_METADATA = "/.well-known/oauth-authorization-server";

/** How long a company's instance has to begin its answer: after its headers, an answer streams as long as it does (MCP's SSE). */
const ANSWER_WAIT_MS = 30_000;

/** The largest form the router reads before it forwards it: a token request's, a revocation's. A `/mcp` body is never read. */
const FORM_LIMIT = 4 * 1024 * 1024;

/** After how many seconds a client may ask again for a company the list has but does not route to now (`Retry-After`). */
const RETRY_AFTER = "60";

/** The request headers a forwarded `/mcp` call keeps besides `Authorization`: what MCP's transport reads. Never a cookie. */
const MCP_HEADERS = ["accept", "content-type", "last-event-id"];

/** The headers of a company's answer the router passes back: never a cookie, nor anything hop-by-hop. */
const ANSWER_HEADERS = ["content-type", "cache-control", "pragma", "www-authenticate", "retry-after", "x-retry-after"];

/** Where a request goes: a listed company's base URL; or why nowhere, the id not in the list, or in it and not routed to now. */
type Routed = { base: string } | "unlisted" | "unavailable";

export interface AgentRouterOptions {
  /** The config's `router`, checked. */
  router: ResolvedRouter;
  /**
   * The router's master secret (`SANOMA_ROUTER_SECRET`, `routerSecretFrom`), which no request
   * carries: each company is sent its own, derived from this and its id (`routerSecretFor`),
   * with a token request or a revocation alone. Without one the router forwards nothing: every
   * route answers 503.
   */
  secret?: string;
  /** Finds a company in the config's list by its id: the request's client (`SanomaClient.routedCompany`). */
  company(id: string): Promise<{ url?: string; live: boolean } | undefined>;
  /** What the router forwards with: `fetch`, unless a test gives its own. */
  fetch?: typeof fetch;
}

export interface AgentRouter {
  /** The one hostname it answers on, in lower case. */
  hostname: string;
  /** Answers a request on that hostname: one of its routes, else 404. */
  handle(request: Request): Promise<Response>;
}

/** A refusal as JSON in OAuth's shape (RFC 6749 §5.2), never kept, with `headers` besides. */
const refuse = (status: number, error: string, description: string, headers: Record<string, string> = {}) =>
  Response.json(
    { error, error_description: description },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );

/** What a client is told of a listed company that is not routed to now: to ask again, and to keep what it holds. */
const unavailable = () =>
  refuse(503, "temporarily_unavailable", "The company is not available right now", { "retry-after": RETRY_AFTER });

/** A 405 naming the methods a route takes. */
const methodNot = (allow: string) =>
  new Response(null, { status: 405, headers: { allow, "cache-control": "no-store" } });

/**
 * The company a token names, with no signature checked: an access token's `sanoma_company`
 * claim (a JWT's payload, decoded), else the tag of a code or a refresh token (`companyOfTag`).
 * Undefined for a token that names none.
 */
export function companyOfToken(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length === 3) {
    const claimed = claimsOf(parts[1]!)?.[COMPANY_CLAIM];
    if (typeof claimed === "string") return claimed;
  }
  return companyOfTag(token);
}

/** A JWT's payload segment as the object it encodes (base64url JSON); undefined for anything else. */
function claimsOf(segment: string): Record<string, unknown> | undefined {
  try {
    const bytes = Uint8Array.from(atob(segment.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The name of a query's pair as it was written (`name=value`), decoded; as written when it does not decode. */
function pairName(pair: string): string {
  const written = pair.split("=", 1)[0]!.replaceAll("+", " ");
  try {
    return decodeURIComponent(written);
  } catch {
    return written;
  }
}

/** A query as it was written, without the router's own `company`: every other pair untouched, in its order. */
const withoutCompany = (search: string): string =>
  search
    .replace(/^\?/, "")
    .split("&")
    .filter((pair) => pair && pairName(pair) !== "company")
    .join("&");

/**
 * A listed company's base URL as the router may send to it, or undefined: an origin as it is
 * compared (`instanceUrl`: no user, query or fragment) with no path, over HTTPS; plain http only
 * for this machine (`isLoopback`), where a test's instance listens. What it forwards carries
 * tokens, codes and a company's secret, so never to plain http elsewhere.
 */
export function companyBase(value: unknown): string | undefined {
  const checked = instanceUrl(value);
  if (!("url" in checked)) return undefined;
  const url = new URL(checked.url);
  if (url.pathname !== "/") return undefined;
  if (url.protocol !== "https:" && !isLoopback(url.hostname)) return undefined;
  return url.origin;
}

/** A well-known path's document, to a GET or a HEAD. */
function discovery(request: Request, document: string): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNot("GET, HEAD");
  return new Response(request.method === "HEAD" ? null : document, {
    headers: { "content-type": "application/json", "cache-control": DISCOVERY_CACHE },
  });
}

/**
 * Makes the router for the config's `router`: `handle` answers, on its hostname,
 *
 * - `GET /.well-known/oauth-protected-resource[/mcp]`: RFC 9728's metadata for its `/mcp`, naming
 *   itself as the one authorization server;
 * - `GET /.well-known/oauth-authorization-server`: RFC 8414's for its issuer (its origin), with
 *   its own `/authorize`, `/token` and `/revoke`, what an instance's document says of the rest
 *   (`agentServerMetadata`) and no `jwks_uri`: it has no keys, and no client checks a token;
 * - `GET /authorize`: the page that asks which company, then a redirect to that company's own
 *   authorize with the client's query as it came;
 * - `POST /token`, `POST /revoke`: the form sent on, unchanged, to the company its code or
 *   token names, and that company's answer back;
 * - `/mcp`: a call with a bearer sent on to the company the token names, its body as it
 *   streams, the answer streamed back; without one, the 401 that starts a client's sign-in;
 *
 * and 404 for anything else. A company the list has but does not route to now (not live, or its
 * URL one the router does not send to, `companyBase`) is a 503 with `Retry-After` on each, never
 * the answer for a code or a token nobody knows: a client keeps what it holds. A token request
 * and a revocation carry the caller's address (`ROUTER_CLIENT_IP_HEADER`, from what the app's
 * host set: `CLIENT_IP_HEADER`) and that company's secret (`ROUTER_SECRET_HEADER`), which its
 * sign-in counts by; a `/mcp` call carries neither. None carries the caller's cookies, and no
 * redirect a company answers is followed or passed on.
 */
export function agentRouter({ router, secret, company, fetch: send = fetch }: AgentRouterOptions): AgentRouter {
  const { hostname, companies } = router;
  const address = routerAddressOf(hostname);
  const { issuer } = address;
  const metadata = resourceMetadataOf(address);
  const documents = new Map<string, string>();
  const resource = JSON.stringify(agentResourceMetadata(address));
  documents.set(metadata.path, resource);
  documents.set(RESOURCE_METADATA, resource);
  documents.set(
    SERVER_METADATA,
    JSON.stringify(
      agentServerMetadata(issuer, {
        authorization_endpoint: `${issuer}${ROUTER_ROUTES.authorize}`,
        token_endpoint: `${issuer}${ROUTER_ROUTES.token}`,
        revocation_endpoint: `${issuer}${ROUTER_ROUTES.revoke}`,
      }),
    ),
  );
  if (!secret) {
    console.error(
      `sanoma app: the router at ${hostname} forwards nothing: SANOMA_ROUTER_SECRET, its master secret, is not set`,
    );
  }

  /**
   * Where the company `id` names is, as the list has it now: the base URL of the record under
   * exactly that key, when the list routes to it (`live`) and its URL is one the router sends to
   * (`companyBase`; one that is not is logged). `unavailable` for a listed company that is not
   * routed to now, `unlisted` for any other id: one that is no id, one the list does not have.
   */
  async function companyAt(id: string | undefined): Promise<Routed> {
    if (id === undefined || !COMPANY_ID.test(id)) return "unlisted";
    const found = await company(id);
    if (!found) return "unlisted";
    if (!found.live) return "unavailable";
    const base = companyBase(found.url);
    if (base === undefined) {
      console.error(
        `sanoma app: the router's company ${id} has no base URL it sends to in ${companies.collection}.${companies.url}: write an https origin with no path, user or query`,
      );
      return "unavailable";
    }
    return { base };
  }

  /**
   * Sends a request on to a company's instance (`base`, from the list) at `path` with `headers`
   * and `body`, and passes its answer back as it comes: status, body (streamed, never read here)
   * and the headers of `ANSWER_HEADERS` and MCP's own. With `signedFor`, the company's id (a
   * token request, a revocation), it carries the caller's address and that company's secret;
   * otherwise neither. A redirect is not followed (it could name any host) and not passed on: a
   * 502. So is an instance that does not begin to answer in `ANSWER_WAIT_MS`, or cannot be
   * reached. When the caller goes away, so does the request to the company, whenever that is.
   */
  async function forward(
    request: Request,
    base: string,
    path: string,
    headers: Headers,
    body: ReadableStream<Uint8Array> | string | null,
    signedFor?: string,
  ): Promise<Response> {
    if (signedFor !== undefined) {
      headers.set(ROUTER_SECRET_HEADER, await routerSecretFor(secret!, signedFor));
      headers.set(ROUTER_CLIENT_IP_HEADER, request.headers.get(CLIENT_IP_HEADER) ?? "");
    }
    const waiting = new AbortController();
    const timer = setTimeout(() => waiting.abort(), ANSWER_WAIT_MS);
    let answered: Response;
    try {
      answered = await send(`${base}${path}`, {
        method: request.method,
        headers,
        // A stream is sent as it is read (`duplex`), never held whole here.
        ...(body !== null && { body, ...(typeof body !== "string" && { duplex: "half" }) }),
        redirect: "manual",
        // The wait for its headers ends at `timer`; the caller's leaving ends it at any time.
        signal: request.signal ? AbortSignal.any([waiting.signal, request.signal]) : waiting.signal,
      } as RequestInit);
    } catch (err) {
      console.error(`sanoma app: the router could not reach ${base}: ${errorMessage(err)}`);
      return refuse(502, "server_error", "The company's instance did not answer");
    } finally {
      clearTimeout(timer);
    }
    if ((answered.status >= 300 && answered.status < 400) || answered.type === "opaqueredirect") {
      await answered.body?.cancel().catch(() => undefined);
      return refuse(502, "server_error", "The company's instance answered with a redirect, which is not followed");
    }
    const passed = new Headers();
    for (const [name, value] of answered.headers) {
      if (ANSWER_HEADERS.includes(name) || name.startsWith("mcp-")) passed.set(name, value);
    }
    if (!passed.has("cache-control")) passed.set("cache-control", "no-store");
    return new Response(answered.body, { status: answered.status, headers: passed });
  }

  /**
   * The page that asks which company an agent's sign-in is for, its form a GET back here with
   * the client's own query in hidden fields (each escaped, never written into the page as it
   * came), and `said` when an id was not found. Unframeable, never kept (`smallPage`).
   */
  function whichCompany(query: URLSearchParams, status: number, said?: string, headers?: Record<string, string>) {
    const kept = [...query]
      .filter(([name]) => name !== "company")
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join("");
    const page = smallPage(
      status,
      "Which company?",
      `<div class="lede"><h1>Which company?</h1>` +
        `<p>An agent asks to sign in. Enter the id of the company it should work in; you sign in there next.</p></div>` +
        `<form method="get" action="${ROUTER_ROUTES.authorize}">${kept}` +
        `<label>Company id<input name="company" required autofocus autocomplete="off" autocapitalize="none" spellcheck="false" value="${escapeHtml(query.get("company") ?? "")}"></label>` +
        `<button class="button">Continue</button></form>` +
        `<p id="message" class="message" role="status">${said ? escapeHtml(said) : ""}</p>`,
    );
    for (const [name, value] of Object.entries(headers ?? {})) page.headers.set(name, value);
    return page;
  }

  /**
   * `GET /authorize`: with no `company`, the page; with one the list routes to, a redirect to
   * that company's own authorize, on its own host (where its sign-in's cookie is), with the
   * client's query as it came, less `company`; with one that is not listed, the page again,
   * saying so (404); with one that is listed and not routed to now, the page saying that (503).
   * Only ever to a URL from the list.
   */
  async function authorize(request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNot("GET, HEAD");
    const asked = url.searchParams.get("company")?.trim();
    if (!asked) return whichCompany(url.searchParams, 200);
    const routed = await companyAt(asked);
    if (routed === "unlisted")
      return whichCompany(url.searchParams, 404, "No company with that id is connected here. Check the id.");
    if (routed === "unavailable") {
      return whichCompany(url.searchParams, 503, "That company is not available right now. Try again in a while.", {
        "retry-after": RETRY_AFTER,
      });
    }
    const query = withoutCompany(url.search);
    return new Response(null, {
      status: 302,
      headers: {
        location: `${routed.base}${STAFF_AUTH_PATH}${STAFF_OAUTH_ROUTES.authorize}${query && `?${query}`}`,
        "cache-control": "no-store",
      },
    });
  }

  /**
   * `POST /token` and `POST /revoke`: the form, unchanged, sent on to the company the form's
   * code or token names (`field`), with the caller's address and that company's secret, and
   * that company's answer. A form that names no listed company is `unknown`'s answer, never sent
   * anywhere; one that names a listed company not routed to now is a 503. The form is read no
   * further than `FORM_LIMIT`.
   */
  async function tokens(
    request: Request,
    route: "token" | "revoke",
    field: (form: URLSearchParams) => string | null,
    unknown: () => Response,
  ): Promise<Response> {
    if (request.method !== "POST") return methodNot("POST");
    if (!request.headers.get("content-type")?.includes("application/x-www-form-urlencoded"))
      return refuse(400, "invalid_request", "Send a form (application/x-www-form-urlencoded)");
    if (Number(request.headers.get("content-length") ?? 0) > FORM_LIMIT)
      return refuse(413, "invalid_request", "The form is too large");
    const text = await bodyText(request, FORM_LIMIT);
    if (text === undefined) return refuse(413, "invalid_request", "The form is too large");
    const named = field(new URLSearchParams(text));
    if (named === null) return refuse(400, "invalid_request", "The form names no code or token");
    const id = companyOfToken(named);
    const routed = await companyAt(id);
    if (routed === "unlisted") return unknown();
    if (routed === "unavailable") return unavailable();
    const kept = new Headers({ "content-type": request.headers.get("content-type")! });
    const accept = request.headers.get("accept");
    if (accept) kept.set("accept", accept);
    return forward(request, routed.base, `${STAFF_AUTH_PATH}${STAFF_OAUTH_ROUTES[route]}`, kept, text, id);
  }

  /**
   * The 401 a client gets at the router's `/mcp` without a token it can be routed by: the app's
   * own (`challenge`), pointing at the router's metadata, which is what starts its sign-in.
   */
  const unrouted = (error?: "invalid_token") =>
    challenge(metadata.url, error, "The access token names no company connected here");

  /**
   * `/mcp`: a GET, POST or DELETE with a bearer goes to the company its token's claim names
   * (read, never verified: that company's sign-in checks the token), with the method,
   * `Authorization` and MCP's headers, and the body as it streams (never read or held here: the
   * company's own `/mcp` bounds it), and the answer comes back as it streams. No secret and no
   * caller's address go with it: nothing there reads either. With no `Authorization`, or another
   * scheme, the 401 that starts a sign-in; with a bearer that names no listed company, the 401
   * that says so; with one that names a listed company not routed to now, a 503.
   */
  async function mcp(request: Request): Promise<Response> {
    if (!["GET", "POST", "DELETE"].includes(request.method)) return methodNot("GET, POST, DELETE");
    const authorization = request.headers.get("authorization");
    const token = bearerJws(authorization);
    if (!token) return unrouted(/^bearer \S/i.test(authorization ?? "") ? "invalid_token" : undefined);
    const claimed = claimsOf(token.split(".")[1]!)?.[COMPANY_CLAIM];
    const routed = await companyAt(typeof claimed === "string" ? claimed : undefined);
    if (routed === "unlisted") return unrouted("invalid_token");
    if (routed === "unavailable") return unavailable();
    const kept = new Headers({ authorization: authorization! });
    for (const [name, value] of request.headers) {
      if (MCP_HEADERS.includes(name) || name.startsWith("mcp-")) kept.set(name, value);
    }
    return forward(request, routed.base, AGENT_SURFACE_PATH, kept, request.method === "POST" ? request.body : null);
  }

  /** The routes that send a request on, by their path: each needs the secret, and answers 503 without it. */
  const routes = new Map<string, (request: Request, url: URL) => Promise<Response>>([
    [ROUTER_ROUTES.authorize, authorize],
    [
      ROUTER_ROUTES.token,
      // RFC 6749 §5.2: a code or a refresh token that is no company's is an invalid grant.
      (request) =>
        tokens(
          request,
          "token",
          (form) => form.get(form.get("grant_type") === "refresh_token" ? "refresh_token" : "code"),
          () => refuse(400, "invalid_grant", "The code or refresh token is not one a company connected here issued"),
        ),
    ],
    [
      ROUTER_ROUTES.revoke,
      // RFC 7009 §2.2: a token the server does not know is no error; the client wanted it
      // unusable, and here it is. Answered as an instance answers one it does not find.
      (request) =>
        tokens(
          request,
          "revoke",
          (form) => form.get("token"),
          () => new Response(null, { status: 200, headers: { "cache-control": "no-store" } }),
        ),
    ],
    [AGENT_SURFACE_PATH, mcp],
  ]);

  return {
    hostname,
    async handle(request) {
      const url = new URL(request.url);
      const document = documents.get(url.pathname);
      if (document !== undefined) return discovery(request, document);
      const route = routes.get(url.pathname);
      if (!route) return plain(404, "Not found\n");
      if (!secret) return plain(503, "The router is not set up: its log says what is missing.\n");
      return route(request, url);
    },
  };
}
