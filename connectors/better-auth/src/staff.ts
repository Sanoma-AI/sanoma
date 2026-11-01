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
import { emailCode, openBetterAuth, type Protocol, protocolOf, withSignOutBody } from "./instance.ts";

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

/** What the session hook reads of Better Auth's endpoint context: the route, and the user's row. */
interface SessionContext {
  path?: string;
  context: { internalAdapter: { findUserById(id: string): Promise<StaffUser | null> } };
}

/** A staff user's row, as far as admission reads it. */
interface StaffUser {
  email: string;
  emailVerified: boolean;
  github?: string | null;
}

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
 * (any POST) to its routes must come from the page's own origin.
 */
export async function betterAuthStaffLogin({ databaseUrl, key, sendCode, staff }: LoginContext): Promise<LoginHalf> {
  if (!staff) throw new Error("better-auth: the staff login needs the app's staff context");
  const github = staff.social.github;
  /** Each invite's token as Better Auth hands it over, by email, until `invite` takes it. */
  const minted = new Map<string, string>();
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
      user: { additionalFields: { github: { type: "string" as const, required: false, input: false } } },
      advanced: { cookiePrefix: "sanoma" },
      ...(github && {
        socialProviders: {
          github: {
            clientId: github.clientId,
            clientSecret: github.clientSecret,
            mapProfileToUser: (profile: { login: string }) => ({ github: profile.login }),
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
            // Nobody the files do not declare gets a row, whatever the route.
            before: async (user: StaffUser) => (staff.admits(identityOf(user)) ? undefined : false),
          },
        },
        session: {
          create: {
            after: async (session: { userId: string }, ctx: SessionContext | null) => {
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
      return authFor(request).handler(withSignOutBody(request, SIGN_OUT));
    },
    signOut: SIGN_OUT,
    methods,
    async invite(email, request) {
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

/** What a user row vouches for: the email when verified, the GitHub login when they signed in with GitHub. */
const identityOf = (user: StaffUser) => ({
  ...(user.emailVerified && { email: user.email }),
  ...(user.github && { github: user.github }),
});

/** A token as the magic link plugin stores it (`storeToken: "hashed"`): SHA-256, base64url without padding. */
const hashed = (token: string) => createHash("sha256").update(token).digest("base64url");
