import {
  INVITE_SECONDS,
  type LoginContext,
  type LoginHalf,
  type LoginMethod,
  sameOrigin,
  type SignInMethod,
} from "sanoma/workflows";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { createAuthMiddleware } from "better-auth/api";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { magicLink } from "better-auth/plugins/magic-link";
import { createHash } from "node:crypto";
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
import { declaredMetadataFetch, oauthPlugins } from "./oauth.ts";

/** Says nothing: a listener for a checked-out client's `error`, whose query fails on its own. */
const quiet = () => undefined;

// The staff login: Better Auth again, as a second instance in a schema of its own, signing in only
// the people the files declare. An email code to a declared email, GitHub through the company's
// own client, and invites (one-use magic links the app mints for a declared email); no password.
// A code or a user row is never made for anyone else: the declared-email check is in Better Auth's
// hooks, not its `disableSignUp`, which would send no code until a user row exists.

/** The schema the staff login's tables are in, beside the visitors' `better_auth`. */
const SCHEMA = SCHEMAS.staff;
const BASE_PATH = "/auth/better-auth";
const SIGN_OUT = `${BASE_PATH}/sign-out`;
const SEND_CODE = "/email-otp/send-verification-otp";
/** How long a staff session lasts: seven days. Who may sign in is read on every request, so removing someone takes effect at once. */
const SESSION_SECONDS = 7 * 24 * 60 * 60;

/** The routes a browser may reach, under `BASE_PATH`: anything else (a magic link's sending among them) is the app's alone. */
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
/**
 * The OAuth provider's routes, with the app's OAuth context only (`staff.oauth`): authorize (a
 * browser's GET), the consent the app's page posts, the token endpoint, revocation (RFC 7009: a
 * public client revokes its own tokens with its client id) and the signing keys' public half.
 * Not registration (no client registers: a declared agent names it), introspection or userinfo,
 * which no resource or client here uses.
 */
const OAUTH_ROUTES = new Set([AUTHORIZE, "/oauth2/consent", TOKEN, REVOKE, "/jwks"]);

/**
 * The routes a non-browser client POSTs to without an `Origin`, each named here on purpose: the
 * token endpoint (RFC 6749 §3.2), its form a code and its PKCE verifier, or a refresh token, and
 * revocation (RFC 7009 §2.1), its form a token to end; never a cookie. Every other change keeps
 * the same-origin rule.
 */
const NO_ORIGIN = new Set([TOKEN, REVOKE]);

/**
 * What RFC 8414's metadata says, of what the provider would: only what is served and supported
 * here. Public clients alone (`none`, at the token endpoint and revocation), so no client secret
 * or assertion; no introspection, DPoP or back-channel logout, which nothing here serves.
 */
const SERVER_METADATA_FIELDS = [
  "issuer",
  "authorization_endpoint",
  "token_endpoint",
  "revocation_endpoint",
  "jwks_uri",
  "scopes_supported",
  "response_types_supported",
  "response_modes_supported",
  "grant_types_supported",
  "code_challenge_methods_supported",
  "authorization_response_iss_parameter_supported",
  "client_id_metadata_document_supported",
] as const;

/** The routes of the email code, which answer only when the app can send one. */
const CODE_ROUTES = new Set([SEND_CODE, "/sign-in/email-otp"]);

/** RFC 9728's metadata for a resource at `path`: its well-known path, with the resource's path appended. */
const RESOURCE_METADATA = "/.well-known/oauth-protected-resource";
/** RFC 8414's metadata for the issuer, `<origin>/auth/better-auth`: the issuer's path appended to the well-known one. */
const SERVER_METADATA = `/.well-known/oauth-authorization-server${BASE_PATH}`;

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
/** What `ensureResource` uses of Better Auth's adapter. */
type ResourceAdapter = HookContext["context"]["adapter"] & {
  create(query: { model: string; data: Record<string, unknown> }): Promise<unknown>;
};
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
  /** Each invite's token as Better Auth hands it over, by email, until `invite` takes it. */
  const minted = new Map<string, string>();
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
          return staff.admits(identity) ? undefined : refused;
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
      // The JWT plugin's own route (a session's JWT) is no client's: off, as Better Auth's docs set it.
      disabledPaths: ["/token"],
      plugins: [
        // Always there, for one shape of the API; without the app's OAuth context no client is
        // declared and `handle` serves none of the provider's routes.
        ...oauthPlugins({ agentOf: oauth?.agentOf ?? (() => undefined), fetchClientMetadata }),
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
          // An authorize `handle` accepted (a declared client, this host's own resource): its
          // resource's row, made here, behind Better Auth's rate limit, which runs before any
          // hook, so a run of requests with made-up hosts is held to it. The provider checks
          // the resource before it looks for a session, so the row is there before a sign-in.
          if (oauth && ctx.path === AUTHORIZE && ctx.request) {
            const { resource } = oauthOrigin(ctx.request, oauth);
            const query = ctx.query as { client_id?: unknown; resource?: unknown } | undefined;
            const client = typeof query?.client_id === "string" ? query.client_id : "";
            if (query?.resource === resource && oauth.agentOf(client) !== undefined)
              await ensureResource(ctx.context.adapter, resource);
            return;
          }
          // An undeclared email is answered as a declared one is, and nothing is stored or sent.
          if (ctx.path !== SEND_CODE) return;
          const email = (ctx.body as { email?: unknown } | undefined)?.email;
          if (typeof email !== "string" || !staff.admits({ email })) return ctx.json({ success: true });
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

  /**
   * The well-known metadata, with the app's OAuth context: RFC 9728's for the resource (at its
   * path, and at the root for a client that looks there), naming this login, on the request's
   * own host, as its one authorization server; and RFC 8414's for that issuer, which the
   * provider answers itself. Undefined for any other well-known path.
   */
  async function discovery(request: Request, pathname: string): Promise<Response | undefined> {
    const { issuer, resource } = oauthOrigin(request, oauth!);
    if (pathname === `${RESOURCE_METADATA}${oauth!.resource}` || pathname === RESOURCE_METADATA) {
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
      return Response.json(
        { resource, authorization_servers: [issuer], bearer_methods_supported: ["header"] },
        { headers: { "cache-control": "public, max-age=300" } },
      );
    }
    if (pathname === SERVER_METADATA) return serverMetadata(await (await authFor(request)).handler(request));
    return undefined;
  }

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
      if (oauth && pathname.startsWith("/.well-known/")) return discovery(request, pathname);
      if (pathname !== BASE_PATH && !pathname.startsWith(`${BASE_PATH}/`)) return undefined;
      const route = pathname.slice(BASE_PATH.length);
      const served = ROUTES.has(route) || (oauth !== undefined && OAUTH_ROUTES.has(route));
      if (!served || (!sendCode && CODE_ROUTES.has(route))) return new Response("Not found", { status: 404 });
      if (request.method !== "GET" && !NO_ORIGIN.has(route) && !sameOrigin(request))
        return new Response("Forbidden", { status: 403 });
      // Any host is allowed, so Better Auth trusts any redirect: only a path on this host is taken.
      if (!localRedirects(new URL(request.url))) return new Response("Bad Request", { status: 400 });
      let asked = request;
      if (oauth && route === AUTHORIZE) {
        const refused = await authorizing(request, oauth);
        if (refused) return refused;
        asked = withoutDpop(request);
      }
      if (oauth && route === TOKEN) {
        const refused = await tokenFor(request, oauth);
        if (refused) return refused;
        asked = withoutDpop(request);
      }
      return (await authFor(request)).handler(withSignOutBody(asked, SIGN_OUT));
    },
    ...(oauth && {
      async bearer(request: Request) {
        const token = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
        if (!token) return null;
        const own = await authFor(request);
        const { issuer, resource } = oauthOrigin(request, oauth);
        // This login's public keys, from its table (never over HTTP): a failure to read them is the
        // app's to report, not a bad token.
        const keys = await own.api.getJwks({ headers: request.headers });
        let payload: Awaited<ReturnType<typeof verifyJwsAccessToken>>;
        try {
          // Signed with one of those keys, for this host's issuer and this host's resource alone,
          // unexpired: jose checks `exp` and `nbf`.
          payload = await verifyJwsAccessToken(token, {
            jwksFetch: async () => keys,
            verifyOptions: {
              issuer,
              audience: resource,
              typ: "at+jwt",
              requiredClaims: ["sub", "azp", "exp", "iat"],
            },
          });
        } catch {
          return null;
        }
        // A sender-constrained (DPoP) token is not a bearer.
        if (payload.cnf !== undefined || typeof payload.sub !== "string" || typeof payload.azp !== "string")
          return null;
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
 * What authorize refuses before the provider sees it: a method but a browser's GET; a client no
 * declared agent stands for (whose document is then never fetched), with what to declare; a
 * resource other than this host's own. Otherwise undefined: the resource's row is made in the
 * provider's pipeline (`hooks.before`), past Better Auth's rate limit.
 */
async function authorizing(request: Request, surface: OAuthContext): Promise<Response | undefined> {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
  const query = new URL(request.url).searchParams;
  const client = query.get("client_id") ?? "";
  if (surface.agentOf(client) === undefined) {
    return refusalPage(
      403,
      `This company declares no agent for the client ${client || "this request names"}.`,
      `To let it act for its people, declare an agent for it in <code>resources/people.ts</code>: ` +
        `<code>sanoma.agent({ id: "&lt;its name&gt;", client: ${escape(JSON.stringify(client))} })</code>, ` +
        `then sign in again.`,
    );
  }
  const { resource } = oauthOrigin(request, surface);
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
 * What the token endpoint refuses before the provider: a client no declared agent stands for
 * any more (a refresh token outlives a declaration). It makes no row: a request here needs no
 * sign-in, so a resource no authorize was accepted for is the provider's `invalid_target`.
 */
async function tokenFor(request: Request, surface: OAuthContext): Promise<Response | undefined> {
  if (request.method !== "POST") return undefined;
  const form = new URLSearchParams(
    await request
      .clone()
      .text()
      .catch(() => ""),
  );
  const client = form.get("client_id");
  if (client !== null && surface.agentOf(client) === undefined) {
    return Response.json(
      {
        error: "invalid_client",
        error_description: `No agent in this company's resources/people.ts stands for the client ${client}`,
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  return undefined;
}

/**
 * The provider's row for `identifier`, this host's own `/mcp`, made the first time an authorize
 * for it is accepted: the provider issues a token only for a resource it has a row for, and
 * which hosts the app answers on is the request's to say, so the rows are made as they are
 * asked, each one this instance's own resource. Two at once make one (the identifier is unique).
 */
async function ensureResource(adapter: ResourceAdapter, identifier: string): Promise<void> {
  const where = [{ field: "identifier", value: identifier }];
  if (await adapter.findOne({ model: "oauthResource", where })) return;
  const now = new Date();
  await adapter
    .create({
      model: "oauthResource",
      data: { identifier, name: "Agent surface", createdAt: now, updatedAt: now },
    })
    .catch(async (err: unknown) => {
      if (!(await adapter.findOne({ model: "oauthResource", where }))) throw err;
    });
}

/** The provider's RFC 8414 answer, narrowed to `SERVER_METADATA_FIELDS`, public clients alone; any other answer as it is. */
async function serverMetadata(answered: Response): Promise<Response> {
  // A HEAD's answer has no body to narrow: its headers are the GET's.
  if (answered.status !== 200 || answered.body === null) return answered;
  const full = (await answered.json()) as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};
  for (const field of SERVER_METADATA_FIELDS) if (full[field] !== undefined) metadata[field] = full[field];
  metadata.token_endpoint_auth_methods_supported = ["none"];
  metadata.revocation_endpoint_auth_methods_supported = ["none"];
  const headers = new Headers(answered.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(metadata), { status: 200, headers });
}

/**
 * The request with DPoP (RFC 9449) left out: authorize's `dpop_jkt` and the token endpoint's
 * `DPoP` proof. The provider cannot be told not to bind a token to a key, and `/mcp` takes Bearer
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

/** The issuer and the resource on the request's own origin: `<origin>/auth/better-auth` and `<origin><resource>`. */
function oauthOrigin(request: Request, oauth: { resource: string }) {
  const origin = `${protocolOf(request)}://${new URL(request.url).host}`;
  return { issuer: `${origin}${BASE_PATH}`, resource: `${origin}${oauth.resource}` };
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A refusal a person reads in the browser they signed in with: no redirect to a client not yet checked. */
function refusalPage(status: number, title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Sign-in refused</title></head><body><main><h1>${escape(title)}</h1><p>${body}</p></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

/** A token as the magic link plugin stores it (`storeToken: "hashed"`): SHA-256, base64url without padding. */
const hashed = (token: string) => createHash("sha256").update(token).digest("base64url");
