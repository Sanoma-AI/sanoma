import {
  INVITE_SECONDS,
  type LoginContext,
  type LoginHalf,
  type LoginMethod,
  sameOrigin,
  type SignInMethod,
} from "@sanoma-ai/workflows";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { magicLink } from "better-auth/plugins/magic-link";
import { createHash } from "node:crypto";
import {
  emailCode,
  GITHUB_FIELD,
  identityOf,
  localRedirects,
  openBetterAuth,
  type Protocol,
  protocolOf,
  type User,
  withSignOutBody,
} from "./instance.ts";

// The staff login: Better Auth again, as a second instance in a schema of its own, signing in only
// the people the files declare. An email code to a declared email, GitHub through the company's
// own client, and invites (one-use magic links the app mints for a declared email); no password.
// A code or a user row is never made for anyone else: the declared-email check is in Better Auth's
// hooks, not its `disableSignUp`, which would send no code until a user row exists.

/** The schema the staff login's tables are in, beside the visitors' `better_auth`. */
const SCHEMA = "better_auth_staff";
const BASE_PATH = "/auth/better-auth";
const SIGN_OUT = `${BASE_PATH}/sign-out`;
const SEND_CODE = "/email-otp/send-verification-otp";
/** GitHub's redirect back, as Better Auth names the route in a hook's context. */
const CALLBACK = "/callback/:id";
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
    internalAdapter: {
      findUserById(id: string): Promise<(User & { id: string }) | null>;
      updateUser(id: string, data: Record<string, unknown>): Promise<unknown>;
      updateAccount(id: string, data: Record<string, unknown>): Promise<unknown>;
      deleteUser(id: string): Promise<void>;
    };
  };
}
/** What the GitHub account hook reads of Better Auth's account row. */
interface GitHubAccount {
  id: string;
  providerId: string;
  userId: string;
  accessToken?: string | null;
}

/** How a session was made, by the route that made it. */
const METHOD_OF: Record<string, SignInMethod> = {
  "/sign-in/email-otp": "code",
  [CALLBACK]: "github",
  "/magic-link/verify": "invite",
};

/**
 * The staff login half (`LoginContext.staff` required): an email code when the app can send one
 * (`sendCode`), GitHub when the company gives its client (`staff.social.github`), and invites
 * (`invite`, `invitation`). Its tables are in schema `better_auth_staff`; its session is one
 * cookie, `sanoma.session_token`, for the host, seven days. A code is sent, and a user made, only
 * for a person `staff.admits`: an undeclared email gets the same answer and leaves nothing.
 * Each sign-in is told to `staff.record`. It answers on any host the app does, so a change
 * (any POST) to its routes must come from the page's own origin.
 */
export async function betterAuthStaffLogin({ databaseUrl, key, sendCode, staff }: LoginContext): Promise<LoginHalf> {
  if (!staff) throw new Error("better-auth: the staff login needs the app's staff context");
  const github = staff.social.github;
  /** Each invite's token as Better Auth hands it over, by email, until `invite` takes it. */
  const minted = new Map<string, string>();
  /** The emails of user rows made on GitHub's redirect back, until `admitByGitHub` decides each. */
  const pending = new Set<string>();

  /**
   * Keeps a GitHub account's login on its user and admits the user by it, once Better Auth has
   * made or linked the user with it (GitHub's redirect back): GitHub's `/user` for the fresh
   * token says whose login it is, then the token goes, which nothing here uses again. A row made
   * for this sign-in that the files declare by neither email nor login goes too, and the sign-in
   * ends in Better Auth's redirect with `error=not_declared`.
   */
  const admitByGitHub = async (account: GitHubAccount | null, ctx: HookContext | null): Promise<void> => {
    if (account?.providerId !== "github" || ctx?.path !== CALLBACK) return;
    const { internalAdapter } = ctx.context;
    let login: string | undefined;
    try {
      if (account.accessToken) {
        const answer = await fetch("https://api.github.com/user", {
          headers: { authorization: `Bearer ${account.accessToken}`, "user-agent": "sanoma" },
        });
        const said = answer.ok ? ((await answer.json()) as { login?: unknown }).login : undefined;
        if (typeof said === "string") login = said;
      }
    } finally {
      await internalAdapter.updateAccount(account.id, { accessToken: null, refreshToken: null, idToken: null });
    }
    const user = await internalAdapter.findUserById(account.userId);
    if (!user) return;
    const made = pending.delete(user.email.toLowerCase());
    if (!staff.admits({ ...identityOf(user), ...(login && { github: login }) })) {
      if (made) await internalAdapter.deleteUser(user.id);
      throw new APIError("FORBIDDEN", {
        code: "not_declared",
        message: "This company's files declare nobody with that GitHub account",
      });
    }
    if (login && user.github !== login) await internalAdapter.updateUser(user.id, { github: login });
  };
  const { auths, close } = await openBetterAuth({
    databaseUrl,
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
      user: { additionalFields: GITHUB_FIELD },
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
        user: {
          create: {
            // Nobody the files do not declare gets a row, whatever the route. On GitHub's redirect
            // back the row is made first and the account hook decides, once GitHub has said whose
            // login it is: Better Auth sets no field from a profile that a person may not set.
            before: async (user: User, ctx: HookContext | null) => {
              if (ctx?.path === CALLBACK) {
                pending.add(user.email.toLowerCase());
                return;
              }
              return staff.admits(identityOf(user)) ? undefined : false;
            },
          },
        },
        account: { create: { after: admitByGitHub } },
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
  const authFor = (request: Request) => auths.get(protocolOf(request))!;
  const methods: LoginMethod[] = [
    ...(sendCode ? (["code"] as const) : []),
    ...(github ? (["github"] as const) : []),
    "invite",
  ];

  /** Mints `email`'s invite, server-side, its token from `minted`; a new one replaces the last. */
  async function mint(email: string, request: Request): Promise<string> {
    const auth = authFor(request);
    const normalized = email.toLowerCase();
    // A new invite replaces the last: the old one's row goes.
    const { adapter } = await auth.$context;
    await adapter.deleteMany({
      model: "verification",
      where: [{ field: "value", value: JSON.stringify({ type: "magic-link", email: normalized }) }],
    });
    await auth.api.signInMagicLink({ body: { email: normalized, callbackURL: "/" }, headers: request.headers });
    const token = minted.get(normalized);
    minted.delete(normalized);
    if (!token) throw new Error("better-auth: the invite was not minted");
    return token;
  }
  /** The invite being minted, which the next waits for. */
  let invites: Promise<unknown> = Promise.resolve();

  return {
    async verify(request) {
      const session = await authFor(request).api.getSession({ headers: request.headers });
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
      return authFor(request).handler(withSignOutBody(request, SIGN_OUT));
    },
    signOut: SIGN_OUT,
    methods,
    invite(email, request) {
      // One at a time: each takes its token from `minted` and replaces the last invite's row.
      const next = invites.then(() => mint(email, request));
      invites = next.catch(() => undefined);
      return next;
    },
    async invitation(token) {
      // The first of the instances: they share the tables.
      const auth = auths.values().next().value!;
      const { internalAdapter } = await auth.$context;
      const found = await internalAdapter.findVerificationValue(`magic-link:${hashed(token)}`);
      if (!found || found.expiresAt < new Date()) return undefined;
      const { email } = JSON.parse(found.value) as { email?: string };
      if (typeof email !== "string") return undefined;
      const query = new URLSearchParams({ token, callbackURL: "/" });
      return { email, path: `${BASE_PATH}/magic-link/verify?${query}` };
    },
    close,
  };
}

/** A token as the magic link plugin stores it (`storeToken: "hashed"`): SHA-256, base64url without padding. */
const hashed = (token: string) => createHash("sha256").update(token).digest("base64url");
