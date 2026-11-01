import type { LoginContext, LoginHalf, LoginMethod } from "@sanoma-ai/workflows";
import { getHostFromSource, matchesHostPattern } from "better-auth";
import { emailCode, openBetterAuth, type Protocol, withSignOutBody } from "./instance.ts";

/** The schema Better Auth's tables (`user`, `session`, `account`, `verification`) live in, on the company's database. */
const SCHEMA = "better_auth";
/** Where its routes are: a site's pages POST to `<BASE_PATH>/sign-up/email`, `/sign-in/email`, `/sign-in/email-otp`… */
const BASE_PATH = "/auth/better-auth";
const SIGN_OUT = `${BASE_PATH}/sign-out`;

/**
 * Better Auth's login half for one public site: email and password, and an email code when the
 * app can send one (`context.sendCode`); every email may sign up. Its tables are in schema
 * `better_auth` on the company's database, migrated here before the first site starts, its
 * cookies signed with the app's key for it (`context.key`). The site's origins are its allowed
 * hosts (a request for another host is refused) and set the cookie's `Secure` flag: an `https`
 * origin's is.
 */
export async function betterAuthLogin({ databaseUrl, key, origins, sendCode }: LoginContext): Promise<LoginHalf> {
  const sites = sitesOf(origins);
  const hosts = new Map<Protocol, string[]>();
  for (const { protocol, host } of sites) hosts.set(protocol, [...(hosts.get(protocol) ?? []), host]);
  const { auths, close } = await openBetterAuth({
    databaseUrl,
    key,
    schema: SCHEMA,
    basePath: BASE_PATH,
    hosts,
    options: () => ({
      emailAndPassword: { enabled: true },
      plugins: sendCode ? [emailCode(sendCode)] : [],
    }),
  });
  /** The instance for the request's host, or none for a host that is not the site's. */
  const authFor = (request: Request) => {
    const host = getHostFromSource(request, false) ?? "";
    const site = sites.find((s) => matchesHostPattern(host, s.host));
    return site && auths.get(site.protocol);
  };
  const methods: LoginMethod[] = ["password", ...(sendCode ? (["code"] as const) : [])];
  return {
    async verify(request) {
      const auth = authFor(request);
      if (!auth) throw new Error(`better-auth: ${request.headers.get("host")} is not one of the site's hosts`);
      // Null for a missing, bad or signed-out cookie.
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return null;
      const { id, email, emailVerified } = session.user;
      return { subject: id, ...(emailVerified && { email }) };
    },
    async handle(request) {
      const { pathname } = new URL(request.url);
      if (pathname !== BASE_PATH && !pathname.startsWith(`${BASE_PATH}/`)) return undefined;
      // Better Auth throws for a host it does not allow, which would be a 500.
      const auth = authFor(request);
      if (!auth) return new Response("Misdirected Request", { status: 421 });
      return auth.handler(withSignOutBody(request, SIGN_OUT));
    },
    signOut: SIGN_OUT,
    methods,
    close,
  };
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
