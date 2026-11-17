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
// address outside that list. On the Worker and on Node alike: it runs on `fetch` and the
// request's client.
import {
  AGENT_SURFACE_PATH,
  agentServerMetadata,
  CLIENT_IP_HEADER,
  COMPANY_CLAIM,
  COMPANY_ID,
  errorMessage,
  RESOURCE_METADATA,
  type ResolvedRouter,
  resourceMetadataOf,
  ROUTER_CLIENT_IP_HEADER,
  ROUTER_SECRET_HEADER,
  STAFF_AUTH_PATH,
  STAFF_OAUTH_ROUTES,
} from "sanoma/workflows";
import { instanceUrl } from "sanoma/workflows/shared";
import { escapeHtml, smallPage } from "./login/page.ts";
import { plain } from "./server/webhooks.ts";

/** The router's own routes, on its hostname: the endpoints its metadata names, and the agent surface. */
export const ROUTER_ROUTES = { authorize: "/authorize", token: "/token", revoke: "/revoke" } as const;

/** Where RFC 8414's metadata for the router's issuer is: the well-known path alone, the issuer having no path. */
const SERVER_METADATA = "/.well-known/oauth-authorization-server";

/** How the router's metadata may be kept: five minutes, by the client alone, as an instance's own. */
const DISCOVERY_CACHE = "private, max-age=300";

/** How long a company's instance has to begin its answer: after its headers, an answer streams as long as it does (MCP's SSE). */
const ANSWER_WAIT_MS = 30_000;

/** The largest body the router reads before it forwards it: a token request's form, a JSON-RPC message. */
const BODY_LIMIT = 4 * 1024 * 1024;

/** The request headers a forwarded `/mcp` call keeps besides `Authorization`: what MCP's transport reads. Never a cookie. */
const MCP_HEADERS = ["accept", "content-type", "last-event-id"];

/** The headers of a company's answer the router passes back: never a cookie, nor anything hop-by-hop. */
const ANSWER_HEADERS = ["content-type", "cache-control", "pragma", "www-authenticate", "retry-after", "x-retry-after"];

/** A record of the companies' collection, as the client reads one (`SanomaClient.record`). */
type CompanyRecord = { key: string; record: Record<string, unknown> } | null;

export interface AgentRouterOptions {
  /** The config's `router`, checked. */
  router: ResolvedRouter;
  /**
   * The secret sent with every forwarded request (`SANOMA_ROUTER_SECRET`), which each company
   * behind the router has too. Without one the router forwards nothing: every route answers 503.
   */
  secret?: string;
  /** Reads a record of a collection by its key: the request's client (`SanomaClient.record`). */
  record(collection: string, key: string): Promise<CompanyRecord>;
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

/** A 405 naming the methods a route takes. */
const methodNot = (allow: string) =>
  new Response(null, { status: 405, headers: { allow, "cache-control": "no-store" } });

/**
 * The company a token names, with no signature checked: an access token's `sanoma_company`
 * claim (a JWT's payload, decoded), else what is before the first `.` of a code or a refresh
 * token. Undefined for a token that names none.
 */
export function companyOfToken(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length === 3) {
    const claimed = claimsOf(parts[1]!)?.[COMPANY_CLAIM];
    if (typeof claimed === "string") return claimed;
  }
  const dot = token.indexOf(".");
  return dot > 0 && dot < token.length - 1 ? token.slice(0, dot) : undefined;
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

/** The request's body, read whole up to `BODY_LIMIT`; undefined when it is larger. */
async function bodyOf(request: Request): Promise<ArrayBuffer | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > BODY_LIMIT) return undefined;
  const bytes = await request.arrayBuffer();
  return bytes.byteLength > BODY_LIMIT ? undefined : bytes;
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
 * - `/mcp`: a call with a bearer sent on to the company the token names, the answer streamed
 *   back; without one, the 401 that starts a client's sign-in;
 *
 * and 404 for anything else. Every forwarded request carries the caller's address
 * (`ROUTER_CLIENT_IP_HEADER`, from what the app's host set: `CLIENT_IP_HEADER`) and the secret
 * (`ROUTER_SECRET_HEADER`); none carries the caller's cookies, and no redirect a company answers
 * is followed or passed on.
 */
export function agentRouter({ router, secret, record, fetch: send = fetch }: AgentRouterOptions): AgentRouter {
  const { hostname, companies } = router;
  const issuer = `https://${hostname}`;
  const address = { issuer, resource: `${issuer}${AGENT_SURFACE_PATH}` };
  const metadata = resourceMetadataOf(address);
  const documents = new Map<string, string>();
  const resource = JSON.stringify({
    resource: address.resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
  });
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
      `sanoma app: the router at ${hostname} forwards nothing: SANOMA_ROUTER_SECRET is not set, here and on each company behind it`,
    );
  }

  /**
   * The base URL of the company `id` names, as the list has it now: the record under exactly
   * that key, routed to (`live`), its URL an http(s) origin. Undefined for any other id: one that
   * is no id, one not listed, one not live, one whose URL is not an origin (which is logged).
   */
  async function companyAt(id: string | undefined): Promise<string | undefined> {
    if (id === undefined || !COMPANY_ID.test(id)) return undefined;
    const found = await record(companies.collection, id);
    if (!found || found.key !== id) return undefined;
    const { live } = companies;
    const state = live && found.record[live.field];
    if (live && (typeof state !== "string" || !live.is.includes(state))) return undefined;
    const checked = instanceUrl(found.record[companies.url]);
    const url = "url" in checked ? new URL(checked.url) : undefined;
    if (!url || url.pathname !== "/") {
      console.error(
        `sanoma app: the router's company ${id} has no base URL in ${companies.collection}.${companies.url}: write an http(s) origin with no path`,
      );
      return undefined;
    }
    return url.origin;
  }

  /**
   * Sends a request on to a company's instance (`base`, from the list) at `path`, with the
   * caller's address and the secret, and passes its answer back as it comes: status, body
   * (streamed, never read here) and the headers of `ANSWER_HEADERS` and MCP's own. A redirect is
   * not followed (it could name any host) and not passed on: a 502. So is an instance that does
   * not begin to answer in `ANSWER_WAIT_MS`, or cannot be reached.
   */
  async function forward(
    request: Request,
    base: string,
    path: string,
    kept: Headers,
    body: ArrayBuffer | string | undefined,
  ): Promise<Response> {
    const headers = new Headers(kept);
    headers.set(ROUTER_SECRET_HEADER, secret!);
    headers.set(ROUTER_CLIENT_IP_HEADER, request.headers.get(CLIENT_IP_HEADER) ?? "");
    const waiting = new AbortController();
    const timer = setTimeout(() => waiting.abort(), ANSWER_WAIT_MS);
    let answered: Response;
    try {
      answered = await send(`${base}${path}`, {
        method: request.method,
        headers,
        ...(body !== undefined && { body }),
        redirect: "manual",
        signal: waiting.signal,
      });
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
  function whichCompany(query: URLSearchParams, status: number, said?: string): Response {
    const kept = [...query]
      .filter(([name]) => name !== "company")
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join("");
    return smallPage(
      status,
      "Which company?",
      `<div class="lede"><h1>Which company?</h1>` +
        `<p>An agent asks to sign in. Enter the id of the company it should work in; you sign in there next.</p></div>` +
        `<form method="get" action="${ROUTER_ROUTES.authorize}">${kept}` +
        `<label>Company id<input name="company" required autofocus autocomplete="off" autocapitalize="none" spellcheck="false" value="${escapeHtml(query.get("company") ?? "")}"></label>` +
        `<button class="button">Continue</button></form>` +
        `<p id="message" class="message" role="status">${said ? escapeHtml(said) : ""}</p>`,
    );
  }

  /**
   * `GET /authorize`: with no `company`, the page; with one that is listed, a redirect to that
   * company's own authorize, on its own host (where its sign-in's cookie is), with the client's
   * query as it came, less `company`; with one that is not, the page again, saying so. Only ever
   * to a URL from the list.
   */
  async function authorize(request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNot("GET, HEAD");
    const asked = url.searchParams.get("company")?.trim();
    if (!asked) return whichCompany(url.searchParams, 200);
    const base = await companyAt(asked);
    if (!base) return whichCompany(url.searchParams, 404, "No company with that id is connected here. Check the id.");
    const query = withoutCompany(url.search);
    return new Response(null, {
      status: 302,
      headers: {
        location: `${base}${STAFF_AUTH_PATH}${STAFF_OAUTH_ROUTES.authorize}${query && `?${query}`}`,
        "cache-control": "no-store",
      },
    });
  }

  /**
   * `POST /token` and `POST /revoke`: the form, unchanged, sent on to the company the form's
   * code or token names (`field`), and that company's answer. A form that names no listed
   * company is `unknown`'s answer, never sent anywhere.
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
    const body = await bodyOf(request);
    if (body === undefined) return refuse(413, "invalid_request", "The form is too large");
    const text = new TextDecoder().decode(body);
    const named = field(new URLSearchParams(text));
    if (named === null) return refuse(400, "invalid_request", "The form names no code or token");
    const base = await companyAt(companyOfToken(named));
    if (!base) return unknown();
    const kept = new Headers({ "content-type": request.headers.get("content-type")! });
    const accept = request.headers.get("accept");
    if (accept) kept.set("accept", accept);
    return forward(request, base, `${STAFF_AUTH_PATH}${STAFF_OAUTH_ROUTES[route]}`, kept, text);
  }

  /**
   * The 401 a client gets at the router's `/mcp` without a token it can be routed by (RFC 6750,
   * with RFC 9728's pointer to the router's own metadata), which is what starts its sign-in.
   */
  const challenge = (error?: "invalid_token") =>
    Response.json(
      { error: "Sign in first" },
      {
        status: 401,
        headers: {
          "cache-control": "no-store",
          "www-authenticate":
            `Bearer ` +
            (error ? `error="${error}", error_description="The access token names no company connected here", ` : "") +
            `resource_metadata="${metadata.url}"`,
        },
      },
    );

  /**
   * `/mcp`: a GET, POST or DELETE with a bearer goes to the company its token's claim names
   * (read, never verified: that company's sign-in checks the token), with the method, the body,
   * `Authorization` and MCP's headers, and the answer comes back as it streams. With no
   * `Authorization`, or another scheme, the 401 that starts a sign-in; with a bearer that names
   * no listed company, the 401 that says so.
   */
  async function mcp(request: Request): Promise<Response> {
    if (!["GET", "POST", "DELETE"].includes(request.method)) return methodNot("GET, POST, DELETE");
    const authorization = request.headers.get("authorization");
    const token = /^bearer ([\w-]+\.[\w-]+\.[\w-]+)$/i.exec(authorization ?? "")?.[1];
    if (!token) return challenge(/^bearer \S/i.test(authorization ?? "") ? "invalid_token" : undefined);
    const claimed = claimsOf(token.split(".")[1]!)?.[COMPANY_CLAIM];
    const base = await companyAt(typeof claimed === "string" ? claimed : undefined);
    if (!base) return challenge("invalid_token");
    const kept = new Headers({ authorization: authorization! });
    for (const [name, value] of request.headers) {
      if (MCP_HEADERS.includes(name) || name.startsWith("mcp-")) kept.set(name, value);
    }
    const body = request.method === "POST" ? await bodyOf(request) : undefined;
    if (request.method === "POST" && body === undefined)
      return refuse(413, "invalid_request", "The message is too large");
    return forward(request, base, AGENT_SURFACE_PATH, kept, body);
  }

  return {
    hostname,
    async handle(request) {
      const url = new URL(request.url);
      const { pathname } = url;
      const document = documents.get(pathname);
      if (document !== undefined) return discovery(request, document);
      const routed =
        pathname === ROUTER_ROUTES.authorize ||
        pathname === ROUTER_ROUTES.token ||
        pathname === ROUTER_ROUTES.revoke ||
        pathname === AGENT_SURFACE_PATH;
      if (!routed) return plain(404, "Not found\n");
      if (!secret) return plain(503, "The router is not set up: its log says what is missing.\n");
      if (pathname === ROUTER_ROUTES.authorize) return authorize(request, url);
      if (pathname === ROUTER_ROUTES.token) {
        // RFC 6749 §5.2: a code or a refresh token that is no company's is an invalid grant.
        return tokens(
          request,
          "token",
          (form) => form.get(form.get("grant_type") === "refresh_token" ? "refresh_token" : "code"),
          () => refuse(400, "invalid_grant", "The code or refresh token is not one a company connected here issued"),
        );
      }
      if (pathname === ROUTER_ROUTES.revoke) {
        // RFC 7009 §2.2: a token the server does not know is no error; the client wanted it
        // unusable, and here it is. Answered as an instance answers one it does not find.
        return tokens(
          request,
          "revoke",
          (form) => form.get("token"),
          () => new Response(null, { status: 200, headers: { "cache-control": "no-store" } }),
        );
      }
      return mcp(request);
    },
  };
}
