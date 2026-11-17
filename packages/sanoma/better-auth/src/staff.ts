import {
  type AgentAddress,
  checkAgentAddress,
  errorMessage,
  INVITE_SECONDS,
  type LoginContext,
  type LoginHalf,
  type LoginMethod,
  RESOURCE_METADATA,
  resourceMetadataOf,
  sameOrigin,
  STAFF_AUTH_PATH,
  type SignInMethod,
} from "sanoma/workflows";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { createAuthMiddleware } from "better-auth/api";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { magicLink } from "better-auth/plugins/magic-link";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  emailCode,
  identityOf,
  localRedirects,
  openBetterAuth,
  type Protocol,
  protocolOf,
  SCHEMAS,
  type User,
  withSignOutBody,
} from "./instance.ts";
import { databaseOn } from "sanoma/workflows/db";
import { oauthResource } from "./db/staff.ts";
import { AGENT_CLAIM, declaredMetadataFetch, GRANT_TYPES, oauthPlugins, SCOPES } from "./oauth.ts";

/** Says nothing: a listener for a checked-out client's `error`, whose query fails on its own. */
const quiet = () => undefined;

// The staff login: Better Auth again, as a second instance in a schema of its own, signing in only
// the people the files declare. An email code to a declared email, GitHub through the company's
// own client, and invites (one-use magic links the app mints for a declared email); no password.
// A code or a user row is never made for anyone else: the declared-email check is in Better Auth's
// hooks, not its `disableSignUp`, which would send no code until a user row exists.

/** The schema the staff login's tables are in, beside the visitors' `better_auth`. */
const SCHEMA = SCHEMAS.staff;
const BASE_PATH = STAFF_AUTH_PATH;
const SIGN_OUT = `${BASE_PATH}/sign-out`;
const SEND_CODE = "/email-otp/send-verification-otp";
/** How long a staff session lasts: seven days. Who may sign in is read on every request, so removing someone takes effect at once. */
const SESSION_SECONDS = 7 * 24 * 60 * 60;

/**
 * The routes a browser may reach, under `BASE_PATH`; anything else is a 404: a magic link's
 * sending, which is the app's alone, and the JWT plugin's own `/token` (a session's JWT), which
 * is no client's.
 */
const ROUTES = new Set([
  SEND_CODE,
  "/sign-in/email-otp",
  "/sign-in/social",
  "/callback/github",
  "/magic-link/verify",
  "/sign-out",
  "/get-session",
]);

const AUTHORIZE = "/oauth2/authorize";
const TOKEN = "/oauth2/token";
const REVOKE = "/oauth2/revoke";
const CONSENT = "/oauth2/consent";
/**
 * Where the provider sends a person whose authorize it cannot answer at the client's redirect
 * (its `getErrorURL`: a redirect the client's document does not list, a client it cannot read),
 * with `error` and `error_description`: a page of this login's (`sentBack`), no route of Better Auth's.
 */
const ERROR = "/error";
/**
 * The OAuth provider's routes, with the app's OAuth context only (`staff.oauth`), each with the
 * field RFC 8414's metadata names it by, so the metadata says a route exactly when it is served:
 * authorize (a browser's GET), the consent the app's page posts (no client's, so no field), the
 * token endpoint, revocation (RFC 7009: a public client revokes its own tokens with its client
 * id) and the signing keys' public half. Not registration (no client registers: a declared agent
 * names it), introspection or userinfo, which no resource or client here uses.
 */
const OAUTH_ROUTES = new Map<string, string | undefined>([
  [AUTHORIZE, "authorization_endpoint"],
  [CONSENT, undefined],
  [TOKEN, "token_endpoint"],
  [REVOKE, "revocation_endpoint"],
  ["/jwks", "jwks_uri"],
]);

/**
 * The routes a non-browser client POSTs to without an `Origin`, each named here on purpose: the
 * token endpoint (RFC 6749 §3.2), its form a code and its PKCE verifier, or a refresh token, and
 * revocation (RFC 7009 §2.1), its form a token to end; never a cookie. Every other change keeps
 * the same-origin rule.
 */
const NO_ORIGIN = new Set([TOKEN, REVOKE]);

/**
 * RFC 8414's metadata for an agent address's issuer: a function of the address alone, made from
 * what is served (`OAUTH_ROUTES`, each endpoint on the issuer, whose path is where the routes
 * are) and supported here (`SCOPES`, `GRANT_TYPES`). Client ID Metadata Documents, public clients
 * alone (`none`, at the token endpoint and revocation), so no client secret or assertion; PKCE
 * `S256`; `iss` on every answer; no registration, introspection, DPoP or back-channel logout,
 * which nothing here serves. A route is added to `OAUTH_ROUTES` with its field, a method here.
 */
export function serverMetadataOf({ issuer }: AgentAddress): Record<string, unknown> {
  const endpoints = [...OAUTH_ROUTES].flatMap(([route, field]) =>
    field === undefined ? [] : [[field, `${issuer}${route}`] as const],
  );
  return {
    issuer,
    ...Object.fromEntries(endpoints),
    scopes_supported: SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: GRANT_TYPES,
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}

/** The routes of the email code, which answer only when the app can send one. */
const CODE_ROUTES = new Set([SEND_CODE, "/sign-in/email-otp"]);

/** Where RFC 8414's metadata for the issuer is: the well-known path with the issuer's own, `BASE_PATH`, appended. */
const SERVER_METADATA = `/.well-known/oauth-authorization-server${BASE_PATH}`;

/**
 * How the metadata documents may be kept: five minutes, by the browser or the client alone. Each
 * is the configured address's, the same whatever the request says, and changes only with the
 * instance's configuration, which a client should not go on reading from a cache between it and
 * the instance.
 */
const DISCOVERY_CACHE = { "cache-control": "private, max-age=300" };

/** The app's OAuth context (`LoginContext.staff.oauth`). */
type OAuthContext = NonNullable<NonNullable<LoginContext["staff"]>["oauth"]>;

/** What `betterAuthStaffLogin` takes besides the app's context. */
export interface StaffLoginOptions {
  /**
   * How a declared client's metadata document is fetched; by default `declaredMetadataFetch()`,
   * `fetch` with redirects refused, which a Worker can do. `sanoma serve` passes
   * `@better-auth/cimd/node`'s, which also pins the address it resolved.
   */
  fetchClientMetadata?: ClientMetadataResourceFetch;
}

/** What the hooks read of Better Auth's endpoint context: the route, and the rows. */
interface HookContext {
  path?: string;
  context: {
    adapter: { findOne(query: { model: string; where: { field: string; value: string }[] }): Promise<unknown> };
    internalAdapter: {
      findUserById(id: string): Promise<User | null>;
      updateUser(id: string, data: Record<string, unknown>): Promise<unknown>;
    };
  };
}
/** What the account hooks read of Better Auth's account row. */
interface Account {
  providerId: string;
  userId: string;
}

/** GitHub's tokens are never kept: a GitHub App's user token reaches what the App and the person both reach. */
const dropTokens = async () => ({ data: { accessToken: null, refreshToken: null, idToken: null } });
/** A GitHub account gone (a code proves an email its unverified row had, and drops its accounts): its user is no longer that login. */
const forgetLogin = async (account: Account | null, ctx: HookContext | null) => {
  if (account?.providerId === "github" && ctx)
    await ctx.context.internalAdapter.updateUser(account.userId, { github: null });
};

/** How a session was made, by the route that made it. */
const METHOD_OF: Record<string, SignInMethod> = {
  "/sign-in/email-otp": "code",
  "/callback/:id": "github",
  "/magic-link/verify": "invite",
};

/**
 * The staff login half (`LoginContext.staff` required): an email code when the app can send one
 * (`sendCode`), GitHub when the company gives its client (`staff.social.github`), and invites
 * (`invite`, `invitation`). Its tables are in schema `better_auth_staff`; its session is one
 * cookie, `sanoma.session_token`, for the host, seven days. A code is sent, and a user made, only
 * for a person `staff.admits`: an undeclared email gets the same answer and leaves nothing.
 * Each sign-in is told to `staff.record`. It answers on any host the app does, so a change
 * (any POST) to its routes must come from the page's own origin. It runs on the pool the app
 * gives each request (`database`), and keeps nothing between requests.
 */
export function betterAuthStaffLogin(
  { database, key, sendCode, staff }: LoginContext,
  { fetchClientMetadata = declaredMetadataFetch() }: StaffLoginOptions = {},
): LoginHalf {
  if (!staff) throw new Error("better-auth: the staff login needs the app's staff context");
  const github = staff.social.github;
  const oauth = staff.oauth;
  /** Both metadata documents, by the path each is served at: made once, from the address alone. */
  const documents = new Map<string, string>();
  if (oauth) {
    try {
      checkAgentAddress(oauth.address);
    } catch (err) {
      throw new Error(`better-auth: ${errorMessage(err)}`, { cause: err });
    }
    const { address } = oauth;
    const resource = JSON.stringify({
      resource: address.resource,
      authorization_servers: [address.issuer],
      bearer_methods_supported: ["header"],
    });
    // RFC 9728's at the resource's own path, and at the root for a client that looks there.
    documents.set(resourceMetadataOf(address).path, resource);
    documents.set(RESOURCE_METADATA, resource);
    documents.set(SERVER_METADATA, JSON.stringify(serverMetadataOf(address)));
  }
  /** Each invite's token as Better Auth hands it over, by email, until `invite` takes it. */
  const minted = new Map<string, string>();
  /**
   * What the access tokens' public keys are kept by (`verifyJwsAccessToken`'s `jwksCacheKey`):
   * one for the login, whichever instance read them. Only the keys' public halves are kept,
   * never an instance or its pool.
   */
  const keysCache = {};
  /** The login GitHub's profile names, by the request it came in, until `keepLogin` writes it. */
  const logins = new WeakMap<object, string>();
  /** Keeps the login GitHub named for this request on the account's user, once the account is made or refreshed. */
  const keepLogin = async (account: Account | null, ctx: HookContext | null) => {
    const login = account?.providerId === "github" && ctx ? logins.get(ctx) : undefined;
    if (login) await ctx!.context.internalAdapter.updateUser(account!.userId, { github: login });
  };
  const auth = openBetterAuth({
    database,
    key,
    schema: SCHEMA,
    ...(oauth && {
      seed: { key: oauth.address.resource, run: (pool: Pool) => ensureResource(pool, oauth.address.resource) },
    }),
    basePath: BASE_PATH,
    // Any host the app answers on: what keeps a change to the page's own origin is `handle`'s check.
    hosts: new Map<Protocol, string[]>([
      ["http", ["*"]],
      ["https", ["*"]],
    ]),
    options: {
      session: { expiresIn: SESSION_SECONDS },
      user: {
        // Nobody the files do not declare gets a row, whatever the route: by the verified email
        // the route proved, or by the login GitHub's own profile names (Better Auth sets no field
        // from a profile that a person may not set, so the login is kept by `keepLogin`), before
        // anything is written. A GitHub sign-in is checked again each time, with the fresh profile.
        validateUserInfo: async ({ user, source }, ctx) => {
          const refused = {
            error: "not_declared",
            errorDescription: "This company's files declare nobody with that account",
          };
          const said = source.oauth?.providerId === "github" ? source.oauth.profile?.login : undefined;
          const login = typeof said === "string" ? said : undefined;
          if (login) logins.set(ctx, login);
          const { adapter, internalAdapter } = ctx.context;
          // A new GitHub account under a login a row already carries is another account (GitHub
          // frees a renamed login): it is not the declared person, whatever the files say.
          if (login && source.action === "create-user") {
            const holder = await adapter.findOne({ model: "user", where: [{ field: "github", value: login }] });
            if (holder) return refused;
          }
          // Signing in again, or linking: GitHub's email may have moved; the row's verified one still vouches.
          const row = typeof user.id === "string" ? await internalAdapter.findUserById(user.id) : null;
          const identity = {
            ...identityOf(user as User),
            ...(row && row.emailVerified && { email: row.email }),
            ...(login && { github: login }),
          };
          return (await staff.admits(identity)) ? undefined : refused;
        },
      },
      advanced: { cookiePrefix: "sanoma" },
      ...(github && {
        socialProviders: {
          github: {
            clientId: github.clientId,
            clientSecret: github.clientSecret,
          },
        },
      }),
      plugins: [
        // Always there, for one shape of the API; without the app's OAuth context no client is
        // declared and `handle` serves none of the provider's routes.
        ...oauthPlugins({
          agentOf: oauth?.agentOf ?? (() => undefined),
          fetchClientMetadata,
          issuer: oauth?.address.issuer,
        }),
        magicLink({
          expiresIn: INVITE_SECONDS,
          storeToken: "hashed",
          sendMagicLink: async ({ email, token }) => void minted.set(email, token),
        }),
        // Always there, for one shape of the API; without a sender, `handle` refuses its routes.
        emailCode(sendCode),
      ],
      hooks: {
        before: createAuthMiddleware(async (ctx) => {
          // An undeclared email is answered as a declared one is, and nothing is stored or sent.
          if (ctx.path !== SEND_CODE) return;
          const email = (ctx.body as { email?: unknown } | undefined)?.email;
          if (typeof email !== "string" || !(await staff.admits({ email }))) return ctx.json({ success: true });
        }),
      },
      databaseHooks: {
        account: {
          create: { before: dropTokens, after: keepLogin },
          update: { before: dropTokens, after: keepLogin },
          delete: { after: forgetLogin },
        },
        session: {
          create: {
            after: async (session: { userId: string }, ctx: HookContext | null) => {
              const method = ctx?.path === undefined ? undefined : METHOD_OF[ctx.path];
              if (!method || !ctx) return;
              const user = await ctx.context.internalAdapter.findUserById(session.userId);
              if (user) await staff.record(method, identityOf(user));
            },
          },
        },
      },
    },
  });
  const authFor = (request: Request) => auth(protocolOf(request));
  const methods: LoginMethod[] = [
    ...(sendCode ? (["code"] as const) : []),
    ...(github ? (["github"] as const) : []),
    "invite",
  ];

  /** The mints of this process, one after another. */
  let mints: Promise<unknown> = Promise.resolve();

  /**
   * Mints `email`'s invite, server-side, its token from `minted`; a new one replaces the last. One
   * at a time per email, whichever process asks: a transaction of its own holds Postgres's lock
   * for the email while the old row goes and the new one is written on the pool's other
   * connections (a transaction's lock is one connection's for the transaction, safe through a
   * pooler), so two mints at once leave one invite, and `minted` hands over the right token. One
   * at a time in the process as well (`mints`): the lock's connection is one of the pool's, and
   * many held at once, each waiting for another of the pool's, would leave none for Better Auth.
   */
  function mint(email: string, request: Request): Promise<string> {
    const minting = mints.then(() => mintNow(email, request));
    mints = minting.catch(() => undefined);
    return minting;
  }

  async function mintNow(email: string, request: Request): Promise<string> {
    const own = await authFor(request);
    const normalized = email.toLowerCase();
    const lock = await (await database()).connect();
    // A checked-out client with no listener would throw its connection's error as uncaught; the query fails instead.
    lock.on("error", quiet);
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`sanoma.login.invite.${normalized}`]);
      // A new invite replaces the last: the old one's row goes.
      const { adapter } = await own.$context;
      await adapter.deleteMany({
        model: "verification",
        where: [{ field: "value", value: JSON.stringify({ type: "magic-link", email: normalized }) }],
      });
      await own.api.signInMagicLink({ body: { email: normalized, callbackURL: "/" }, headers: request.headers });
      await lock.query("COMMIT");
    } catch (err) {
      await lock.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      lock.off("error", quiet);
      lock.release();
    }
    const token = minted.get(normalized);
    minted.delete(normalized);
    if (!token) throw new Error("better-auth: the invite was not minted");
    return token;
  }

  return {
    async verify(request) {
      const session = await (await authFor(request)).api.getSession({ headers: request.headers });
      return session ? { subject: session.user.id, ...identityOf(session.user) } : null;
    },
    async handle(request) {
      const { pathname } = new URL(request.url);
      // With no agent address no well-known path is a document of this login's: a 404 too.
      if (pathname.startsWith("/.well-known/")) return discovery(request, documents.get(pathname));
      if (pathname !== BASE_PATH && !pathname.startsWith(`${BASE_PATH}/`)) return undefined;
      const route = pathname.slice(BASE_PATH.length);
      if (oauth && route === ERROR) return sentBack(request);
      const served = ROUTES.has(route) || (oauth !== undefined && OAUTH_ROUTES.has(route));
      if (!served || (!sendCode && CODE_ROUTES.has(route))) return new Response("Not found", { status: 404 });
      if (request.method !== "GET" && !NO_ORIGIN.has(route) && !sameOrigin(request))
        return new Response("Forbidden", { status: 403 });
      // Any host is allowed, so Better Auth trusts any redirect: only a path on this host is taken.
      if (!localRedirects(new URL(request.url))) return new Response("Bad Request", { status: 400 });
      const refused = oauth && (await GUARDS.get(route)?.(request, oauth));
      if (refused) return refused;
      const asked = route === AUTHORIZE ? withConsentAsked(request) : request;
      return (await authFor(request)).handler(withSignOutBody(withoutDpop(asked), SIGN_OUT));
    },
    ...(oauth && {
      async bearer(request: Request) {
        // The scheme in any case (RFC 9110 §11.1); the token a JWS in compact form.
        const token = /^bearer ([\w-]+\.[\w-]+\.[\w-]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
        if (!token) return null;
        const own = await authFor(request);
        const { issuer, resource } = oauth.address;
        let payload: Awaited<ReturnType<typeof verifyJwsAccessToken>>;
        try {
          // Signed with one of this login's keys, as the configured issuer and for the configured
          // resource alone, whatever host the request came in on, unexpired: jose checks `exp`
          // and `nbf`. The public keys are read from the
          // login's table (never over HTTP) through this request's instance, and kept by
          // `verifyJwsAccessToken` under `keysCache`: five minutes, read again at once for a key
          // id they lack (at most every thirty seconds), one read shared by those that wait.
          payload = await verifyJwsAccessToken(token, {
            jwksCacheKey: keysCache,
            jwksFetch: () =>
              own.api.getJwks({ headers: request.headers }).catch((err: unknown) => {
                throw new KeysUnread(err);
              }),
            verifyOptions: {
              issuer,
              audience: resource,
              typ: "at+jwt",
              requiredClaims: ["sub", "azp", "exp", "iat"],
            },
          });
        } catch (err) {
          // The keys not read (or not in the five seconds a read another request began is waited
          // for) is the app's to report, not a bad token.
          if (err instanceof KeysUnread) throw err.cause;
          if ((err as { code?: unknown } | null)?.code === "ERR_JWKS_TIMEOUT") throw err;
          return null;
        }
        // A sender-constrained (DPoP) token is not a bearer.
        if (payload.cnf !== undefined || typeof payload.sub !== "string" || typeof payload.azp !== "string")
          return null;
        // It is the agent's its person consented to (`AGENT_CLAIM`), and no other's: once the
        // files move its client to another agent it is refused, as is one that names none. A
        // client no agent stands for any more is the app's admission to refuse, by its name.
        const consented = payload[AGENT_CLAIM];
        const agent = await oauth.agentOf(payload.azp);
        if (typeof consented !== "string" || (agent !== undefined && agent !== consented)) return null;
        // Who it is for, as their row says now: a user since removed holds nothing.
        const user = await (await own.$context).internalAdapter.findUserById(payload.sub);
        return user ? { subject: payload.sub, ...identityOf(user as User), client: payload.azp } : null;
      },
    }),
    signOut: SIGN_OUT,
    methods,
    invite: mint,
    async invitation(token) {
      // Either protocol's instance: they share the tables.
      const { internalAdapter } = await (await auth("https")).$context;
      const found = await internalAdapter.findVerificationValue(`magic-link:${hashed(token)}`);
      if (!found || found.expiresAt < new Date()) return undefined;
      const { email } = JSON.parse(found.value) as { email?: string };
      if (typeof email !== "string") return undefined;
      const query = new URLSearchParams({ token, callbackURL: "/" });
      return { email, path: `${BASE_PATH}/magic-link/verify?${query}` };
    },
  };
}

/**
 * What authorize refuses before the provider sees it, on a page a person reads: a method but a
 * browser's GET; a client no agent stands for (the provider would only redirect to its error
 * page), saying where one is declared, or what the app says of it instead (`refusalOf`: a
 * built-in client the company turned off is said to be off, never to be declared); a resource other than the configured address's,
 * whatever host the request names (the provider would refuse it too, having no row for it, but
 * at the client's redirect). Otherwise undefined.
 */
async function authorizing(request: Request, surface: OAuthContext): Promise<Response | undefined> {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
  const query = new URL(request.url).searchParams;
  const client = query.get("client_id") ?? "";
  const { resource } = surface.address;
  if ((await surface.agentOf(client)) === undefined) {
    const said = await surface.refusalOf?.(client);
    if (said) {
      return refusalPage(
        403,
        said.title,
        `The client is <code>${escape(client || "(none)")}</code>. ${escape(said.detail)}`,
      );
    }
    // What is missing and where, never a declaration to paste: the client id is whatever the
    // link that sent the person here says, and a link anyone can send.
    return refusalPage(
      403,
      "This company declares no agent for the client this sign-in names.",
      `The client is <code>${escape(client || "(none)")}</code>. An agent that may act for this ` +
        `company's people is declared in <code>resources/people.ts</code>, by its client. ` +
        `Declare only a client you chose to connect yourself: one a link or a message asks you to ` +
        `add would act for the people who sign in to it.`,
    );
  }
  if (query.get("resource") !== resource) {
    return refusalPage(
      400,
      "This sign-in asks for a resource this company does not serve.",
      `Its agent surface is <code>${escape(resource)}</code>: ask for it as the <code>resource</code>.`,
    );
  }
  return undefined;
}

/**
 * The page for `ERROR`: what the provider said went wrong with a client's sign-in, its code and
 * its description as text (they are the link's to say, and anyone can write such a link), and
 * what to do about it. A GET's alone.
 */
function sentBack(request: Request): Response {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const query = new URL(request.url).searchParams;
  const said = (name: string) => escape((query.get(name) ?? "").slice(0, 300));
  const error = said("error");
  const description = said("error_description");
  return refusalPage(
    400,
    "This sign-in could not go on.",
    (error ? `The sign-in answered <code>${error}</code>${description ? `: ${description}` : ""}. ` : "") +
      `Start the sign-in again: from the agent, when one sent you here. If it stops here again, the agent's client is not set up as this company's sign-in needs.`,
  );
}

/**
 * What the consent refuses before the provider: an answer for a client no declared agent stands
 * for any more, though the consent page was shown while one did. The provider finds no such
 * client either (`oauthPlugins`' gate) and gives no code, but answers 200 with where its error
 * page is: here it is a 403. Its client is the signed request's (`oauth_query`, whose signature
 * the provider checks next). Otherwise undefined.
 */
async function consenting(request: Request, surface: OAuthContext): Promise<Response | undefined> {
  if (request.method !== "POST") return undefined;
  // The consent page posts JSON; a form is read too, so no shape of the body passes unread.
  const text = await request
    .clone()
    .text()
    .catch(() => "");
  const form = request.headers.get("content-type")?.includes("application/x-www-form-urlencoded");
  const said = form ? new URLSearchParams(text).get("oauth_query") : jsonField(text, "oauth_query");
  const query = typeof said === "string" ? said : "";
  const client = new URLSearchParams(query).get("client_id") ?? "";
  if ((await surface.agentOf(client)) !== undefined) return undefined;
  return Response.json(
    {
      error: "invalid_client",
      error_description: "No agent in this company's resources/people.ts stands for this client",
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}

/** `field` of the JSON object `text`, or undefined when it is not one. */
function jsonField(text: string, field: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>)[field] : undefined;
  } catch {
    return undefined;
  }
}

/** What a route answers itself ahead of the provider, with the app's OAuth context: each guard for the methods it names. */
const GUARDS = new Map([
  [AUTHORIZE, authorizing],
  [CONSENT, consenting],
]);

/**
 * The request with DPoP (RFC 9449) left out, whatever the route: authorize's `dpop_jkt` and the
 * token endpoint's `DPoP` proof. The provider cannot be told not to bind a token to a key, and `/mcp` takes Bearer
 * tokens alone, so a DPoP-capable client would be issued a token it cannot use, and sign in again
 * for ever. The metadata names no DPoP algorithm, so a client asks for none; one that does anyway
 * is answered as a server without DPoP answers it: the proof ignored, the `token_type` it gets `Bearer`.
 */
function withoutDpop(request: Request): Request {
  const url = new URL(request.url);
  if (!url.searchParams.has("dpop_jkt") && !request.headers.has("dpop")) return request;
  url.searchParams.delete("dpop_jkt");
  const headers = new Headers(request.headers);
  headers.delete("dpop");
  return new Request(url, new Request(request, { headers }));
}

/**
 * An authorize with the consent page always shown (`prompt=consent`, as the client itself may
 * ask), unless its redirect is the client's alone (`ownAddress`). The provider remembers a
 * consent and, finding one, sends the code on with nothing shown: right for a site, whose
 * redirect only it answers, but a loopback redirect matches on any port, so any program on the
 * person's computer that opened the same link would be handed a code for a client they once
 * allowed (RFC 8252 §8.6). With `prompt=none` too the provider refuses the two together, so such
 * a client gets an error at its redirect, never a code unseen.
 */
function withConsentAsked(request: Request): Request {
  const url = new URL(request.url);
  if (ownAddress(url.searchParams.get("redirect_uri"))) return request;
  const prompt = new Set((url.searchParams.get("prompt") ?? "").split(" ").filter(Boolean));
  if (prompt.has("consent")) return request;
  url.searchParams.set("prompt", [...prompt, "consent"].join(" "));
  return new Request(url, request);
}

/**
 * Whether a redirect is an address only its client answers at: HTTPS, and not this computer
 * (`localhost`, `127.0.0.0/8`, `[::1]`). Not a loopback address, nor an app's own scheme, which
 * any program on the computer may take.
 */
function ownAddress(redirect: string | null): boolean {
  let url: URL;
  try {
    url = new URL(redirect ?? "");
  } catch {
    return false;
  }
  const host = url.hostname;
  const loopback =
    host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(\.\d+){3}$/.test(host);
  return url.protocol === "https:" && !loopback;
}

/**
 * A well-known path's answer: `document` when the login serves one there (RFC 9728's metadata
 * for the configured resource, naming the configured issuer as its one authorization server, and
 * RFC 8414's for that issuer), to a GET or a HEAD, the same whatever `Host` the request names,
 * with no instance of Better Auth and nothing read. Any other well-known path is a 404, never
 * the sign-in page a client would take for a document: RFC 8414's at another path is not this
 * issuer's, there is no OpenID provider, and with no agent address there is no document at all.
 */
function discovery(request: Request, document: string | undefined): Response {
  if (document === undefined) return notFound();
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const headers = { "content-type": "application/json", ...DISCOVERY_CACHE };
  return new Response(request.method === "HEAD" ? null : document, { headers });
}

/**
 * The provider's row for the configured resource, made when missing: once per process and
 * database (`openBetterAuth`'s `seed`), before the login's first instance there, so before any
 * authorize, and by no request's query. The provider issues a token only for a resource it has
 * a row for. Two processes at once make one (the identifier is unique). A row a former address
 * left stays: `bearer` refuses a token for it.
 */
async function ensureResource(pool: Pool, identifier: string): Promise<void> {
  const now = new Date();
  await databaseOn(pool)
    .insert(oauthResource)
    .values({ id: randomUUID(), identifier, name: "Agent surface", createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: oauthResource.identifier });
}

/** No document, or no route, of this login's: never kept. */
const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A refusal a person reads in the browser they signed in with: no redirect to a client not yet checked. */
function refusalPage(status: number, title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Sign-in refused</title></head><body><main><h1>${escape(title)}</h1><p>${body}</p></main></body></html>`,
    { status, headers: PAGE_HEADERS },
  );
}

/** The refusal page's headers, as the app's own small pages are sent: never kept, and framed by no page, so no other site lays it under a click of its own. */
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
};

/** The token keys' table could not be read (`cause` says why): never a bad token. */
class KeysUnread extends Error {
  constructor(cause: unknown) {
    super("better-auth: the token keys could not be read", { cause });
  }
}

/** A token as the magic link plugin stores it (`storeToken: "hashed"`): SHA-256, base64url without padding. */
const hashed = (token: string) => createHash("sha256").update(token).digest("base64url");
