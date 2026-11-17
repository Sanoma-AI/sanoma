import { AsyncLocalStorage } from "node:async_hooks";
import {
  ADMIN,
  type AgentAddress,
  CONSENT_PAGE,
  errorMessage,
  INVITE_SECONDS,
  LOGIN_AGENT,
  LOGIN_CODE_WORKFLOW,
  LOGIN_PAGE,
  type LoginContext,
  type LoginHalf,
  type LoginIdentity,
  openInvite,
  personOf,
  principalOf,
  requestOrigin,
  RESOURCE_METADATA,
  sameOrigin,
  sealLoginCode,
  type SocialClients,
} from "sanoma/workflows";
import { admit } from "sanoma/workflows/describe";
import { agentOfClient, personsOf } from "sanoma/workflows/shared";
import { z } from "zod";
import type { AppContext, LoginProvider } from "../context.ts";
import type { AppSnapshot } from "../snapshot.ts";
import { secretValues } from "../server/secrets.ts";
import { loginKey } from "./keys.ts";
import { type Company, companyOf, firstWordOf, initialsOf } from "../lib/names.ts";
import { escapeHtml, type PageFrame, smallPage, wantsJson } from "./page.ts";

// The staff login on a host: a login half (Better Auth's, `betterAuthStaffLogin`) made once the app
// listens, given what only the app has: the client's pool, who the files declare, the sender (a
// `login-code` run as the runtime's agent `login`), the company's GitHub client, and the ledger a
// sign-in goes to. On Node and on a Worker alike: the half reaches the database through the
// request's client, and keeps nothing between requests.
// Here too: the sign-in page (`/auth/login`, and any page asked for signed out), an invite's
// landing page and `POST /auth/invite`. And the agent surface's own sign-in, when the instance has
// an agent address (`AgentAddress`, one, configured: `agentAddressOf` the app's public hostname):
// the half is the authorization server for `/mcp` (`LoginContext.staff.oauth`), whose sign-in and
// consent pages are these, and a request to `/mcp` with a bearer is the client's, checked by the
// half and admitted as the declared agent that stands for that client, for the person who signed
// it in; without one, `/mcp` answers the 401 that starts a client's sign-in, which names the
// configured address's metadata whatever host the request came in on. With no address there is
// no OAuth: `/mcp` is a signed-in person's alone, and its 401 says what to set.

/** Makes the staff login half from the app's context: `betterAuthStaffLogin`. */
export type MakeStaffLogin = (context: LoginContext) => LoginHalf | Promise<LoginHalf>;

/** The company's own OAuth clients, each a sign-in method when given. */
export type StaffSocial = SocialClients;

const INVITE = "/auth/invite";
/** The agent surface (`routes/mcp.ts`): the one path a bearer is taken at, and the path of the resource the half issues tokens for. */
const MCP = "/mcp";
/** The half's own routes (Better Auth's), where it is the issuer: the sign-in page posts there too. */
const HALF = "/auth/better-auth";

/**
 * The agent address of an app reached at `hostname` over HTTPS (`SANOMA_HOSTNAME`): the staff
 * login there as the issuer, `https://<hostname>/auth/better-auth`, and the agent surface as the
 * resource, `https://<hostname>/mcp`.
 */
export function agentAddressOf(hostname: string): AgentAddress {
  const origin = `https://${hostname.toLowerCase()}`;
  return { issuer: `${origin}${HALF}`, resource: `${origin}${MCP}` };
}

/** A bearer, `Authorization: Bearer …` (the scheme in any case, RFC 9110 §11.1): what a client sends `/mcp` once signed in. */
const hasBearer = (request: Request) => /^bearer \S/i.test(request.headers.get("authorization") ?? "");

/** Whether `pathname` is the agent surface's: `/mcp`, or `/mcp/`, which its route answers too. */
const atMcp = (pathname: string) => pathname === MCP || pathname === `${MCP}/`;

/**
 * Whether the request is a client's: any `Authorization` at `/mcp`, then that alone says who
 * (a bearer the half checks; any other scheme, a DPoP token among them, nobody), never a cookie's.
 */
const byToken = (request: Request) => request.headers.has("authorization") && atMcp(new URL(request.url).pathname);

/** Whether a page was sent here by the half's authorize: its query is signed (`sig`), which the half checks. */
const signedQuery = (url: URL) => url.searchParams.has("sig");

/** `POST /auth/invite`'s body: a declared colleague's email from someone signed in, or a sealed request (`sealInvite`). */
const InviteBody = z.union([z.object({ email: z.string().email() }), z.object({ request: z.string().min(1) })]);

/**
 * Signs people in with the login half `make` makes (`betterAuthStaffLogin`), once the app listens
 * (`open`): `resolveActor` returns what it verified (`{ email, github }`), which the app matches to
 * a declared person (`admitting`). A request without a session gets the sign-in page (a 401), or
 * JSON for a server function; `GET /auth/login` is the page itself (a 200, or back to `/` when
 * signed in as someone declared), and the kit's stylesheet and fonts load signed out for it. Besides the half's
 * routes: `GET /auth/invite/<token>`, an invite's
 * landing page, and `POST /auth/invite`, which mints one (`invite`) for `{ email }` from someone
 * signed in, or for `{ request }` sealed under `SANOMA_SIGNING_KEY` (`sealInvite`): `{ url }`.
 * With `address`, the instance's one agent address, the half is the agent surface's authorization
 * server for it; with none it serves no OAuth, and no agent signs in to `/mcp`.
 */
export function staffLogin(make: MakeStaffLogin, social: StaffSocial = {}, address?: AgentAddress): LoginProvider {
  let app: AppContext | undefined;
  let half: LoginHalf | undefined;
  /** Whether `open` failed: the half is then never made, and the pages say so rather than "starting". */
  let failed = false;
  /** The company as its files say when asked (`open`'s `current`). */
  let current: (() => AppSnapshot | Promise<AppSnapshot>) | undefined;
  /**
   * What each request under way has read of the files. The half asks who is declared through
   * callbacks that carry no request (`admits`, `agentOf`, several times in one authorize), so
   * the request is found by the call it is made in, as the Worker's entry finds its client.
   */
  const underWay = new AsyncLocalStorage<Reading>();
  const readings = new WeakMap<Request, Reading>();
  /** Runs `answer` as part of `request`: what it reads of the files, the request reads once. */
  const during = <T>(request: Request, answer: () => T): T => {
    let reading = readings.get(request);
    if (!reading) readings.set(request, (reading = {}));
    return underWay.run(reading, answer);
  };
  /**
   * Who the files declare, as they say now: read at each request that asks, so a person or a
   * client taken out is refused at the login's own routes too, with no page asked in between;
   * and once for that request, however often it asks (on Node each read checks every file's
   * stamp, `liveSnapshot`). Outside a request (`invite`), read as asked.
   */
  const people = (): Promise<AppSnapshot["people"]> => {
    const reading = underWay.getStore();
    return reading ? (reading.people ??= declaredBy(current!)) : declaredBy(current!);
  };
  /** How the login's pages look: the kit's stylesheet, and the company they are for. */
  const frame = (): PageFrame =>
    app ? { ...(app.stylesheet && { stylesheet: app.stylesheet }), company: companyOf(app.resolved.name) } : {};
  /**
   * The same, or undefined when the files could not be read (a file that does not load, which
   * the log then names): for what must not fail on it. Nobody is admitted meanwhile, as the app's
   * own admission refuses every request then ("could not be checked", `admitting`).
   */
  const peopleIfRead = () =>
    people().catch((err: unknown) => {
      console.error(`sanoma app: who is declared could not be read: ${errorMessage(err)}`);
      return undefined;
    });
  /** The declared person `identity` names, as admitted, or undefined: for anyone else, and while the people cannot be read. */
  const admitted = async (identity: LoginIdentity) => {
    const declared = await peopleIfRead();
    if (!declared) return undefined;
    try {
      return admit(identity, declared, true);
    } catch {
      return undefined;
    }
  };
  /** Who a bearer at `/mcp` was issued for and to which client, once per request: `handle` asks, then admission. */
  const tokenOf = oncePerRequest(async (request): Promise<LoginIdentity | undefined> => {
    const token = await half?.bearer?.(request);
    if (!token) return undefined;
    const { email, github, client } = token;
    return { ...(email && { email }), ...(github && { github }), client };
  });
  /** Who the half says is signed in, once per request: `handle` asks, then admission. */
  const identityOf = oncePerRequest(async (request): Promise<LoginIdentity | undefined> => {
    const session = await half?.verify(request);
    if (!session) return undefined;
    const { email, github } = session;
    return { ...(email && { email }), ...(github && { github }) };
  });

  const provider: LoginProvider = {
    name: "staff",
    // The half's (Better Auth's), which the sign-in page posts to as well.
    signOut: `${HALF}/sign-out`,
    check() {},
    async open(context, snapshot) {
      app = context;
      current = snapshot;
      const { client, resolved } = context;
      try {
        half = await make({
          database: () => client.pool(),
          key: loginKey("staff"),
          secrets: secretValues(client),
          origins: [],
          ...(resolved.login && { sendCode: (email, code) => sendLoginCode(client, email, code) }),
          staff: {
            admits: async (identity) => (await admitted(identity)) !== undefined,
            social,
            // The agent surface's authorization server, for the one configured address: tokens
            // for its resource, and a client only as the agent the files declare for it, as they
            // read now. With no address the half serves no OAuth.
            ...(address && {
              oauth: { address, agentOf: async (id) => agentOfClient(id, (await people()).people) },
            }),
            // Never throws: the half made the session already, and the ledger's line is not its to lose it for.
            async record(method, identity) {
              const declared = await peopleIfRead();
              const person = declared && personOf(identity, declared.people);
              if (person === undefined) return;
              await client
                .recordSignIn(person, method)
                .catch((err: unknown) => console.error(`sanoma app: ${person}'s sign-in was not recorded:`, err));
            },
          },
        });
      } catch (err) {
        failed = true;
        throw err;
      }
    },
    resolveActor: (request) => (byToken(request) ? tokenOf(request) : identityOf(request)),
    async handle(request) {
      if (!half) {
        return failed
          ? smallPage(503, "Sign-in", "<p>Sign-in is not available on this host. The app's log says why.</p>")
          : smallPage(503, "Starting", "<p>The app is starting. Try again in a moment.</p>");
      }
      const own = await half.handle(request);
      if (own) return own;
      const url = new URL(request.url);
      const { pathname } = url;
      if (pathname === INVITE && request.method === "POST") return mint(request);
      if (pathname.startsWith(`${INVITE}/`) && request.method === "GET")
        return landing(pathname.slice(INVITE.length + 1));
      if (lookFile(pathname, app?.stylesheet)) return undefined;
      // A client's request: its bearer alone says who, or the 401 that sends it to sign in again;
      // another scheme gets the challenge that names the one taken here.
      if (byToken(request)) {
        if (!hasBearer(request)) return challenge(address);
        return (await tokenOf(request)) ? undefined : challenge(address, "invalid_token");
      }
      const signedIn = await identityOf(request);
      if (pathname === LOGIN_PAGE && request.method === "GET") {
        // On to the app only for someone it admits: a session of someone no longer declared signs
        // in again here, as does anyone a client's sign-in sent here (the provider asks again).
        if (signedIn && !signedQuery(url) && (await admitted(signedIn)))
          return new Response(null, { status: 302, headers: { location: "/", "cache-control": "no-store" } });
        return signInPage(half, frame(), 200, url.searchParams.get("error"));
      }
      if (pathname === CONSENT_PAGE && request.method === "GET") {
        const person = signedIn && (await admitted(signedIn));
        return person ? consentPage(url, person) : signInPage(half, frame(), 401);
      }
      if (signedIn) return undefined;
      if (atMcp(pathname)) return challenge(address);
      // A well-known path nobody answered is no document of this host's: a 404, whatever the
      // half serves there, never the sign-in page, which a client would read as one.
      if (pathname.startsWith("/.well-known/"))
        return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
      return wantsJson(request) ? refuse(401, "Sign in first") : signInPage(half, frame(), 401);
    },
    async invite(email, { origin, by }) {
      if (!half?.invite || !app) throw new Error("The app is starting");
      const person = personOf({ email }, (await people()).people);
      if (person === undefined) throw new Error(`${email} is not a declared person's email`);
      const { host, protocol } = new URL(origin);
      const token = await half.invite(
        email,
        new Request(origin, { headers: { host, "x-forwarded-proto": protocol.slice(0, -1) } }),
      );
      const expiresAt = new Date(Date.now() + INVITE_SECONDS * 1000);
      await app.client.recordInvite(person, { by, expiresAt });
      return { url: `${origin}${INVITE}/${token}`, expiresAt };
    },
  };

  /**
   * The consent page for a client's sign-in (`url`, the half's signed request): which client asks,
   * as which declared agent, for `person` and the company, with Allow and Deny, which post the
   * signed request back to the half (`/oauth2/consent`). A client no agent stands for any more is
   * refused here too.
   */
  async function consentPage(url: URL, person: { id: string }): Promise<Response> {
    const client = url.searchParams.get("client_id") ?? "";
    const { people: declared } = await people();
    const agent = agentOfClient(client, declared);
    const look = frame();
    const company = look.company?.name ?? "this company";
    if (agent === undefined) {
      return smallPage(
        403,
        "Not declared",
        `<p>${escapeHtml(company)} declares no agent for the client <code>${escapeHtml(client)}</code>. Agents are declared in <code>resources/people.ts</code>: declare one only for a client you chose to connect.</p>`,
        look,
      );
    }
    const who = personsOf(declared).find((p) => p.id === person.id) ?? person;
    return smallPage(
      200,
      "Allow access",
      `<div class="lede"><h1>Let ${escapeHtml(agent)} act for you?</h1>` +
        `<p>${escapeHtml(client)} asks to work in ${escapeHtml(company)} as the agent <strong>${escapeHtml(agent)}</strong>, ` +
        `for ${escapeHtml(nameOf(who))}. It may do only what both you and that agent may do, and the company's policy decides each call.</p></div>` +
        `<div class="links"><button id="allow" type="button" class="button">Allow</button>` +
        `<button id="deny" type="button" class="link">Deny</button></div>` +
        `<p id="message" class="message" role="status"></p><script>${CONSENT_SCRIPT}</script>`,
      look,
    );
  }

  /** `POST /auth/invite`: `{ email }` from someone signed in and declared, on this page; `{ request }` sealed with the signing key. */
  async function mint(request: Request): Promise<Response> {
    const body = InviteBody.safeParse(await request.json().catch(() => undefined));
    if (!body.success) return refuse(400, "Send { email } or { request }");
    let email: string;
    let by: string;
    if ("request" in body.data) {
      const opened = openInvite(body.data.request);
      if (!opened) return refuse(403, "That invite request is not one this deployment sealed, or it expired");
      // Each sealed request mints once, whichever process answers: a copy of it, replayed before
      // it expires, mints nothing (its nonce is a row until then).
      if (!(await app!.client.spendInviteRequest(opened.nonce, new Date(opened.exp))))
        return refuse(403, "That invite request was used already");
      ({ email } = opened);
      by = LOGIN_AGENT;
    } else {
      if (!sameOrigin(request)) return refuse(403, "Ask for an invite from this app's own page");
      const identity = await identityOf(request);
      const asking = identity && (await admitted(identity));
      if (!asking) return refuse(401, "Sign in first");
      // An invite signs its holder in as that person: only an admin hands one out.
      if (!asking.groups?.includes(ADMIN)) return refuse(403, `Only someone in ${ADMIN} makes an invite link`);
      ({ email } = body.data);
      by = asking.id;
    }
    if (personOf({ email }, (await people()).people) === undefined) {
      return refuse(403, `${email} is not a declared person's email`);
    }
    const { url } = await provider.invite!(email, { origin: requestOrigin(request), by });
    return Response.json({ url }, { headers: { "cache-control": "no-store" } });
  }

  /**
   * An invite's landing page: who sent it, whom it signs in, as declared, and a link that does, so a
   * link preview never uses it up. A sealed request's invite (`by` the agent `login`) names no sender.
   */
  async function landing(token: string): Promise<Response> {
    const invitation = await half!.invitation?.(token).catch((err: unknown) => {
      console.error(`sanoma app: an invite could not be read: ${errorMessage(err)}`);
      return undefined;
    });
    if (!invitation) {
      return smallPage(
        410,
        "Invite",
        "<p>This invite link has been used, replaced or has expired. Ask for a new one.</p>",
        frame(),
      );
    }
    // Whom it names is the page's words only: when the people file does not load, the link still
    // shows, without them.
    const invited = await named(invitation.email).catch((err: unknown): Invited => {
      console.error(`sanoma app: whom an invite names could not be read: ${errorMessage(err)}`);
      return {};
    });
    const look = frame();
    return smallPage(200, "Invite", invitePage(look.company!, invitation, invited), look);
  }

  /** The declared person an invite for `email` signs in, with their groups, and who sent it (none for a sealed request's). */
  async function named(email: string): Promise<Invited> {
    const declared = (await people()).people;
    const persons = personsOf(declared);
    const invited = persons.find((p) => p.id === personOf({ email }, declared));
    if (!invited) return {};
    const sent = await app!.client.lastInvite(invited.id).catch((err: unknown) => {
      console.error(`sanoma app: who sent ${invited.id}'s invite could not be read: ${errorMessage(err)}`);
      return undefined;
    });
    const sender =
      sent && sent.by !== LOGIN_AGENT ? (persons.find((p) => p.id === sent.by) ?? { id: sent.by }) : undefined;
    const person = { ...invited, groups: principalOf(invited.id, declared)?.groups ?? [] };
    return { person, ...(sender && { sender }) };
  }

  return {
    ...provider,
    resolveActor: (request) => during(request, () => provider.resolveActor(request)),
    handle: (request) => during(request, () => provider.handle!(request)),
  };
}

/** The people a snapshot read now declares. */
const declaredBy = async (current: () => AppSnapshot | Promise<AppSnapshot>) => (await current()).people;

/** What a request has read of the company's files so far: the people, once it asked. */
interface Reading {
  people?: Promise<AppSnapshot["people"]>;
}

/**
 * Mails a sign-in code, as a run of the built-in `login-code` workflow started by the runtime's
 * agent `login`, the code sealed (`sealLoginCode`): under the policy and in the ledger like any
 * send. What the staff login and every visitor login send their codes with.
 */
export async function sendLoginCode(client: AppContext["client"], email: string, code: string): Promise<void> {
  await client.start(LOGIN_CODE_WORKFLOW, { to: email, code: sealLoginCode(email, code) }, { startedBy: LOGIN_AGENT });
}

/**
 * The 401 a client gets at `/mcp` without a token it may use (RFC 6750, with RFC 9728's pointer to
 * the resource's metadata), which is what starts its sign-in; `error` says why one was refused.
 * The metadata is the configured address's, on the resource's own origin, whatever host the
 * request came in on: a client that reached the app by another name is sent to the one address
 * tokens are issued for. With no address no client can sign in: the 401 names no scheme, and says
 * what to set.
 */
function challenge(address: AgentAddress | undefined, error?: "invalid_token"): Response {
  if (!address) return refuse(401, NO_ADDRESS);
  const resource = new URL(address.resource);
  const metadata = `${resource.origin}${RESOURCE_METADATA}${resource.pathname}`;
  const why = error
    ? `error="${error}", error_description="The access token is not one this company's sign-in issued for its agent surface, or it expired", `
    : "";
  return refuse(401, "Sign in first", { "www-authenticate": `Bearer ${why}resource_metadata="${metadata}"` });
}

/** What `/mcp` says to a client on an instance with no agent address: why no agent signs in, and the setting that gives it one. */
const NO_ADDRESS =
  "No agent can sign in here: this instance has no agent address. Set SANOMA_HOSTNAME to the hostname the app is " +
  "reached at over HTTPS (on the Cloudflare host, the container's hostname), and an agent signs in at https://<hostname>/mcp";

/** A refusal as JSON saying why (`POST /auth/invite`'s, a server function's, `/mcp`'s), never kept, with `headers` besides. */
const refuse = (status: number, error: string, headers: Record<string, string> = {}) =>
  Response.json({ error }, { status, headers: { "cache-control": "no-store", ...headers } });

/** `read`'s answer for a request, asked for once however often it is called for that request. */
function oncePerRequest<T>(read: (request: Request) => Promise<T>): (request: Request) => Promise<T> {
  const answers = new WeakMap<Request, Promise<T>>();
  return (request) => {
    let answer = answers.get(request);
    if (!answer) answers.set(request, (answer = read(request)));
    return answer;
  };
}

/** What a page names a declared person by: their name, else their id. */
type Named = { id: string; name?: string };
const nameOf = (person: Named) => person.name ?? person.id;
/** Whom an invite signs in, as declared with their groups, and who sent it: what its landing page names. */
type Invited = { person?: Named & { groups: string[] }; sender?: Named };
const firstNameOf = (person: Named) => firstWordOf(nameOf(person));

/** `a`, `a and b`, `a, b and c`. */
const listOf = (items: readonly string[]) =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** The built files the sign-in page loads signed out: the kit's stylesheet, and the fonts it names under assets/. */
const lookFile = (pathname: string, stylesheet: string | undefined) =>
  stylesheet !== undefined && (pathname === stylesheet || /^\/assets\/[\w.-]+\.woff2?$/.test(pathname));

/** What the page says when GitHub sends someone back with `?error=<code>` (Better Auth's codes). */
const GITHUB_ERRORS: Record<string, string> = {
  email_not_found:
    "GitHub did not share an email. The company's GitHub App needs the Email addresses permission; ask the person who runs this company.",
  account_not_linked:
    "An account with your GitHub email exists, but that email is not verified on both sides yet. Sign in with a code first.",
  account_already_linked_to_different_user:
    "That GitHub account already signs in as someone else. Use a code, or another GitHub account.",
  unable_to_link_account: "GitHub could not be connected to your account. Sign in with a code and try again.",
  not_declared:
    "This company's files declare nobody with that GitHub account. Ask the person who runs this company to add you, or sign in with a code.",
};
const GITHUB_FAILED = "GitHub sign-in did not work. Try again, or use a code.";
/** What the page says for `?error=<code>`: its own line for a code it knows (never one an object inherits), else `GITHUB_FAILED`. */
const githubError = (code: string) => (Object.hasOwn(GITHUB_ERRORS, code) ? GITHUB_ERRORS[code]! : GITHUB_FAILED);

/**
 * The sign-in page: an email, then the six-digit code sent to it, and GitHub when the company has
 * a client; one neutral message, whether the email is declared or not. Without the code, it says
 * to ask for an invite link (GitHub beside it when on) and names nothing else: anyone can reach it.
 * `error` is the code a failed GitHub sign-in came back with.
 */
function signInPage(half: LoginHalf, frame: PageFrame, status: number, error?: string | null): Response {
  const methods = half.methods ?? [];
  const company = frame.company?.name ?? "this company";
  const github = methods.includes("github")
    ? `<div class="or">or</div><button id="github" type="button" class="button outline">${GITHUB_ICON}<span>Continue with GitHub</span></button>`
    : "";
  const message = `<p id="message" class="message" role="status">${error ? escapeHtml(githubError(error)) : ""}</p>`;
  const script = `<script>${SIGN_IN_SCRIPT}</script>`;
  if (!methods.includes("code")) {
    return smallPage(
      status,
      "Sign in",
      `<div class="lede"><span class="badge">Email sign-in not set up</span><h1>Ask for an invite link</h1>` +
        `<p>Sign-in by email is not set up for ${escapeHtml(company)} yet. Ask the person who runs it for an invite link; it signs you in once and expires in 24 hours.</p></div>` +
        github +
        message +
        (github ? script : ""),
      frame,
    );
  }
  return smallPage(
    status,
    "Sign in",
    `<div id="email-step" class="step"><div class="lede"><h1>Sign in to ${escapeHtml(company)}</h1>` +
      `<p>We will email you a six-digit code. No password.</p></div>` +
      `<form id="email"><label>Work email<input type="email" name="email" required autocomplete="email" autofocus></label>` +
      `<button class="button">Send a code</button></form>${github}</div>` +
      `<div id="code-step" class="step" hidden><div class="lede"><h1>Check your email</h1>` +
      `<p>If that address is declared, a code is on its way. It can take a minute.</p></div>` +
      `<form id="code"><label>Six-digit code<input class="code" name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code"></label>` +
      `<p class="small muted">3 wrong codes end the attempt. A code lasts five minutes.</p>` +
      `<button class="button">Sign in</button></form>` +
      `<div class="links"><button id="different" type="button" class="link">Use a different email</button>` +
      `<button id="again" type="button" class="link">Send again</button></div>` +
      `<p id="resent" class="small muted" hidden>Sent again. The earlier code no longer works.</p></div>` +
      message +
      script,
    {
      ...frame,
      footer: `${escapeHtml(company)} · signed in people are declared in <code>resources/people.ts</code>`,
    },
  );
}

/**
 * An invite's landing page: `sender` invited the declared `person` (with their groups), whom
 * `invitation` signs in once; without a sender (a sealed request's invite), "You were invited".
 */
function invitePage(
  company: Company,
  invitation: { email: string; path: string },
  { person, sender }: Invited,
): string {
  const faces = [sender, person]
    .filter((p): p is Named => p !== undefined)
    .map((p) => `<span class="face" aria-hidden="true">${escapeHtml(initialsOf(nameOf(p)))}</span>`)
    .join("");
  const where = `<code>resources/people.ts</code>`;
  const as =
    person &&
    `as ${escapeHtml(nameOf(person))}${person.groups.length ? `, in ${escapeHtml(listOf(person.groups))}` : ""}`;
  const lede = sender
    ? `<h1>${escapeHtml(firstNameOf(sender))} invited you to ${escapeHtml(company.name)}</h1>` +
      (as ? `<p>${escapeHtml(nameOf(sender))} declared you in ${where} ${as}.</p>` : "")
    : `<h1>You were invited to ${escapeHtml(company.name)}</h1>` +
      (as ? `<p>You are declared in ${where} ${as}.</p>` : "");
  return (
    (faces && `<div class="faces">${faces}</div>`) +
    `<div class="lede">${lede}</div>` +
    `<a class="button tall" href="${escapeHtml(invitation.path)}">Continue as ${escapeHtml(invitation.email)}</a>` +
    `<p class="small muted note">${CLOCK_ICON}<span>This link works once and expires in 24 hours.</span></p>` +
    `<p class="rule">Not ${escapeHtml(person ? firstNameOf(person) : invitation.email)}? <a href="${LOGIN_PAGE}">Sign in with your own email</a></p>`
  );
}

const GITHUB_ICON = `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/></svg>`;
const CLOCK_ICON = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;

/**
 * What the consent page does: it posts the person's answer and the half's signed request (the
 * page's own query) to the half's consent, and goes where the half says: back to the client, with
 * a code or with `access_denied`.
 */
const CONSENT_SCRIPT = `
const say=(text)=>{document.getElementById("message").textContent=text};
const answer=async(accept)=>{const done=await fetch("/auth/better-auth/oauth2/consent",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accept,oauth_query:location.search.slice(1)})}).catch(()=>null);
const {url}=done?.ok?await done.json().catch(()=>({})):{};if(url){location.assign(url);return}say("That did not work. Start the sign-in again from the agent.")};
document.getElementById("allow").addEventListener("click",()=>answer(true));
document.getElementById("deny").addEventListener("click",()=>answer(false));
`;

/**
 * What the sign-in page does: it posts JSON to the login's routes (Better Auth's email code and
 * GitHub), says what went wrong by Better Auth's error codes, and once signed in goes on where a
 * client's sign-in continues (when the half's authorize sent it here: its signed query is posted
 * along, `oauth_query`, and the half answers the consent page or the client's redirect), else back
 * to the page asked for on this host (`/` from the sign-in page itself; leading slashes count as one, so
 * a path like `//elsewhere` never leads off it). A GitHub sign-in that fails comes back to
 * `/auth/login?error=<code>`, with the signed query before it when there is one, so a code after
 * it still goes on with the client's sign-in.
 *
 * The signed query is the page's own without what the half did not sign (the parameters it names
 * in `ba_param`, and `sig`): the `error` GitHub's failure adds would undo the signature. It lasts
 * ten minutes; after that the half answers `invalid_signature`, to a code or to GitHub's start,
 * which the page says as the client's sign-in having expired, never as a wrong code.
 */
const SIGN_IN_SCRIPT = `
const post=(path,body)=>fetch("/auth/better-auth"+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
const $=(id)=>document.getElementById(id);const message=$("message");const say=(text)=>{message.textContent=text};
const here="/"+location.pathname.replace(/^[/]+/,"");const back=here===${JSON.stringify(LOGIN_PAGE)}?"/":here+location.search;
const AGAIN="That did not work. Try again in a moment.";let email="";let wrong=0;
const asked=new URLSearchParams(location.search);const names=new Set(asked.getAll("ba_param"));
const signed=asked.has("sig")?new URLSearchParams([...asked].filter(([name])=>!names.size||name==="sig"||name==="ba_param"||names.has(name))).toString():"";
const oauth=signed?{oauth_query:signed}:{};
const EXPIRED="This sign-in from the agent has expired. Start it again from the agent.";const expired=(said)=>said?.error==="invalid_signature";
const next=async(done)=>{const {url}=signed?await done.json().catch(()=>({})):{};location.assign(url||back)};
const send=()=>post("/email-otp/send-verification-otp",{email,type:"sign-in"}).then((r)=>r.ok,()=>false);
$("email")?.addEventListener("submit",async(e)=>{e.preventDefault();email=String(new FormData(e.target).get("email"));
if(!await send()){say(AGAIN);return}
say("");wrong=0;$("email-step").hidden=true;$("code-step").hidden=false;$("resent").hidden=true;$("code").reset();$("code").querySelector("input").focus()});
$("code")?.addEventListener("submit",async(e)=>{e.preventDefault();
const done=await post("/sign-in/email-otp",{email,otp:String(new FormData(e.target).get("otp")),...oauth}).catch(()=>null);
if(done?.ok){await next(done);return}
if(!done){say(AGAIN);return}
const said=await done.json().catch(()=>({}));const {code}=said;
if(expired(said)){say(EXPIRED);return}
if(code==="OTP_EXPIRED")say("That code has expired. Send a new one.");
else if(code==="TOO_MANY_ATTEMPTS"||++wrong>=3)say("Three wrong codes: send a new one.");
else say("That code did not work. Check it, or send a new one.")});
$("again")?.addEventListener("click",async()=>{if(!await send()){say(AGAIN);return}
say("");wrong=0;$("resent").hidden=false;$("code").reset();$("code").querySelector("input").focus()});
$("different")?.addEventListener("click",()=>{say("");$("code-step").hidden=true;$("email-step").hidden=false;$("email").querySelector("input").focus()});
$("github")?.addEventListener("click",async()=>{
const started=await post("/sign-in/social",{provider:"github",callbackURL:back,errorCallbackURL:${JSON.stringify(LOGIN_PAGE)}+(signed&&"?"+signed),...oauth}).then((r)=>r.json()).catch(()=>({}));
if(started.url)location.href=started.url;else say(expired(started)?EXPIRED:"GitHub sign-in did not start. Try again in a moment.")});
`;
