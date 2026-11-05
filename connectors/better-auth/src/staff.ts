import {
  INVITE_SECONDS,
  type LoginContext,
  type LoginHalf,
  type LoginMethod,
  sameOrigin,
  type SignInMethod,
} from "@sanoma-ai/workflows";
import { createAuthMiddleware } from "better-auth/api";
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

/** The routes of the email code, which answer only when the app can send one. */
const CODE_ROUTES = new Set([SEND_CODE, "/sign-in/email-otp"]);

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
export function betterAuthStaffLogin({ database, key, sendCode, staff }: LoginContext): LoginHalf {
  if (!staff) throw new Error("better-auth: the staff login needs the app's staff context");
  const github = staff.social.github;
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
      plugins: [
        magicLink({
          expiresIn: INVITE_SECONDS,
          storeToken: "hashed",
          sendMagicLink: async ({ email, token }) => void minted.set(email, token),
        }),
        // Always there, for one shape of the API; without a sender, `handle` refuses its routes.
        emailCode(sendCode),
      ],
      hooks: {
        // An undeclared email is answered as a declared one is, and nothing is stored or sent.
        before: createAuthMiddleware(async (ctx) => {
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
   * Mints `email`'s invite, server-side, its token from `minted`; a new one replaces the last. One
   * at a time per email, whichever process asks: a transaction of its own holds Postgres's lock
   * for the email while the old row goes and the new one is written on the pool's other
   * connections (a transaction's lock is one connection's for the transaction, safe through a
   * pooler), so two mints at once leave one invite, and `minted` hands over the right token.
   */
  async function mint(email: string, request: Request): Promise<string> {
    const own = await authFor(request);
    const normalized = email.toLowerCase();
    const lock = await (await database()).connect();
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
      if (pathname !== BASE_PATH && !pathname.startsWith(`${BASE_PATH}/`)) return undefined;
      const route = pathname.slice(BASE_PATH.length);
      if (!ROUTES.has(route) || (!sendCode && CODE_ROUTES.has(route)))
        return new Response("Not found", { status: 404 });
      if (request.method !== "GET" && !sameOrigin(request)) return new Response("Forbidden", { status: 403 });
      // Any host is allowed, so Better Auth trusts any redirect: only a path on this host is taken.
      if (!localRedirects(new URL(request.url))) return new Response("Bad Request", { status: 400 });
      return (await authFor(request)).handler(withSignOutBody(request, SIGN_OUT));
    },
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

/** A token as the magic link plugin stores it (`storeToken: "hashed"`): SHA-256, base64url without padding. */
const hashed = (token: string) => createHash("sha256").update(token).digest("base64url");
