import type { LoginContext, LoginHalf, LoginMethod } from "@sanoma-ai/workflows";
import { getHostFromSource, matchesHostPattern } from "better-auth";
import {
  emailCode,
  GITHUB_FIELD,
  identityOf,
  localRedirects,
  openBetterAuth,
  type Protocol,
  type User,
  withSignOutBody,
} from "./instance.ts";

/** The schema Better Auth's tables (`user`, `session`, `account`, `verification`) live in, on the company's database. */
const SCHEMA = "better_auth";
/** Where its routes are: a site's pages POST to `<BASE_PATH>/sign-up/email`, `/sign-in/email`, `/sign-in/email-otp`… */
const BASE_PATH = "/auth/better-auth";
const SIGN_OUT = `${BASE_PATH}/sign-out`;

/** What a GitHub account hook reads of Better Auth's account row and endpoint context. */
interface LinkedAccount {
  id: string;
  providerId: string;
  userId: string;
  accessToken?: string | null;
}
interface HookContext {
  path?: string;
  context: {
    internalAdapter: {
      findAccounts(userId: string): Promise<{ providerId: string }[]>;
      updateAccount(id: string, data: Record<string, unknown>): Promise<unknown>;
      updateUser(id: string, data: Record<string, unknown>): Promise<unknown>;
    };
    socialProviders: { id: string; getUserInfo(tokens: { accessToken: string }): Promise<unknown> }[];
  };
}

/**
 * Better Auth's login half for one public site: email and password, and an email code when the
 * app can send one (`context.sendCode`); every email may sign up. With the company's GitHub client
 * (`context.social.github`), a visitor signed in links their GitHub account
 * (`/link-social`), then may sign in with it (`/sign-in/social`, which never makes an account), and is then said to be that GitHub
 * login (`verify`'s `github`). Its tables are in schema `better_auth` on the company's database,
 * migrated here before the first site starts, its cookies signed with the app's key for it
 * (`context.key`). The site's origins are its allowed hosts (a request for another host is
 * refused) and set the cookie's `Secure` flag: an `https` origin's is.
 */
export async function betterAuthLogin({
  databaseUrl,
  key,
  origins,
  sendCode,
  social,
}: LoginContext): Promise<LoginHalf> {
  const github = social?.github;
  const sites = sitesOf(origins);
  const hosts = new Map<Protocol, string[]>();
  for (const { protocol, host } of sites) hosts.set(protocol, [...(hosts.get(protocol) ?? []), host]);
  const { auths, close } = await openBetterAuth({
    databaseUrl,
    key,
    schema: SCHEMA,
    basePath: BASE_PATH,
    hosts,
    options: {
      emailAndPassword: { enabled: true },
      plugins: sendCode ? [emailCode(sendCode)] : [],
      user: { additionalFields: GITHUB_FIELD },
      ...(github && {
        // GitHub never makes an account, nor joins one by its email: a visitor signs up by email,
        // links GitHub (`/link-social`), and may then sign in with it.
        socialProviders: {
          github: { clientId: github.clientId, clientSecret: github.clientSecret, disableSignUp: true },
        },
        // A visitor's GitHub email is seldom the one they signed in with. Linking still needs
        // GitHub to have verified its email (GitHub is no trusted provider).
        account: { accountLinking: { allowDifferentEmails: true, disableImplicitLinking: true } },
        databaseHooks: {
          account: {
            create: { before: oneGitHub, after: noteLogin },
            update: { after: noteLogin },
            delete: { after: forgetLogin },
          },
        },
      }),
    },
  });
  /** The instance for the request's host, or none for a host that is not the site's. */
  const authFor = (request: Request) => {
    const host = getHostFromSource(request, false) ?? "";
    const site = sites.find((s) => matchesHostPattern(host, s.host));
    return site && auths.get(site.protocol);
  };
  const methods: LoginMethod[] = [
    "password",
    ...(sendCode ? (["code"] as const) : []),
    ...(github ? (["github"] as const) : []),
  ];
  return {
    async verify(request) {
      const auth = authFor(request);
      if (!auth) throw new Error(`better-auth: ${request.headers.get("host")} is not one of the site's hosts`);
      // Null for a missing, bad or signed-out cookie.
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return null;
      return { subject: session.user.id, ...identityOf(session.user as User) };
    },
    async handle(request) {
      const { pathname } = new URL(request.url);
      if (pathname !== BASE_PATH && !pathname.startsWith(`${BASE_PATH}/`)) return undefined;
      // Better Auth throws for a host it does not allow, which would be a 500.
      const auth = authFor(request);
      if (!auth) return new Response("Misdirected Request", { status: 421 });
      // Better Auth checks a redirect in a body against the site's hosts; one in the query must be a path here.
      if (!localRedirects(new URL(request.url))) return new Response("Bad Request", { status: 400 });
      return auth.handler(withSignOutBody(request, SIGN_OUT));
    },
    signOut: SIGN_OUT,
    methods,
    close,
  };
}

/** A visitor has one GitHub account at most: another is refused (Better Auth's `unable_to_link_account`). */
async function oneGitHub(account: LinkedAccount, ctx: HookContext | null): Promise<false | void> {
  if (account.providerId !== "github" || !ctx) return;
  const accounts = await ctx.context.internalAdapter.findAccounts(account.userId);
  if (accounts.some((a) => a.providerId === "github")) return false;
}

/**
 * Keeps a GitHub account's login on its user, once Better Auth has linked it or signed its user
 * in with it (GitHub's redirect back, `/callback/:id`), then drops the account's tokens, which
 * nothing here uses again: a GitHub App's user token reaches what the App and the person both
 * reach. The login is the provider's profile for that token, since Better Auth sets no field from
 * a profile that a person may not set (`input: false`), the GitHub login among them.
 */
async function noteLogin(account: LinkedAccount | null, ctx: HookContext | null): Promise<void> {
  if (account?.providerId !== "github" || !account.accessToken || ctx?.path !== "/callback/:id") return;
  const { internalAdapter, socialProviders } = ctx.context;
  const provider = socialProviders.find((p) => p.id === "github")!;
  const info = (await provider.getUserInfo({ accessToken: account.accessToken })) as { data?: { login?: unknown } };
  const login = info?.data?.login;
  if (typeof login !== "string") throw new Error("better-auth: GitHub did not say whose account was linked");
  await internalAdapter.updateUser(account.userId, { github: login });
  await internalAdapter.updateAccount(account.id, { accessToken: null, refreshToken: null, idToken: null });
}

/** A GitHub account unlinked: its user is no longer that login. */
async function forgetLogin(account: LinkedAccount | null, ctx: HookContext | null): Promise<void> {
  if (account?.providerId === "github" && ctx)
    await ctx.context.internalAdapter.updateUser(account.userId, { github: null });
}

/** Each origin's host, as Better Auth's `allowedHosts` has it (`account.localhost:*`), and its protocol. */
function sitesOf(origins: readonly string[]): { host: string; protocol: Protocol }[] {
  if (!origins.length) throw new Error("better-auth: a site needs an origin");
  return origins.map((origin) => {
    const [, protocol, host] = /^(https?):\/\/([^/]+)$/.exec(origin) ?? [];
    if (!host)
      throw new Error(
        `better-auth: an origin is a scheme and a host alone, such as https://example.com, not ${origin}`,
      );
    return { host, protocol: protocol as Protocol };
  });
}
