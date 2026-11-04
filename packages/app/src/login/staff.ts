import {
  ADMIN,
  errorMessage,
  INVITE_SECONDS,
  LOGIN_AGENT,
  LOGIN_CODE_WORKFLOW,
  type LoginContext,
  type LoginHalf,
  type LoginIdentity,
  openInvite,
  personOf,
  principalOf,
  requestOrigin,
  sameOrigin,
  sealLoginCode,
  type SocialClients,
} from "@sanoma-ai/workflows";
import { admit, readPeople } from "@sanoma-ai/workflows/describe";
import { personsOf } from "@sanoma-ai/workflows/shared";
import { z } from "zod";
import type { AppContext, LoginProvider } from "../context.ts";
import { secretValues } from "../server/secrets.ts";
import { loginKey } from "./keys.ts";
import { firstWordOf, initialsOf } from "../lib/names.ts";
import { type Company, companyOf, escapeHtml, type PageFrame, smallPage, wantsJson } from "./page.ts";

// The staff login on a host: a login half (Better Auth's, `betterAuthStaffLogin`) made once the app
// listens, given what only the app has: who the files declare, the sender (a `login-code` run as
// the runtime's agent `login`), the company's GitHub client, and the ledger a sign-in goes to.
// Here too: the sign-in page (`/auth/login`, and any page asked for signed out), an invite's
// landing page and `POST /auth/invite`.

/** Makes the staff login half from the app's context: `betterAuthStaffLogin`. */
export type MakeStaffLogin = (context: LoginContext) => Promise<LoginHalf>;

/** The company's own OAuth clients, each a sign-in method when given. */
export type StaffSocial = SocialClients;

const INVITE = "/auth/invite";
/** The sign-in page's own address, where a GitHub sign-in that failed comes back to with `?error=`. */
const LOGIN = "/auth/login";

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
 */
export function staffLogin(make: MakeStaffLogin, social: StaffSocial = {}): LoginProvider {
  let app: AppContext | undefined;
  let half: LoginHalf | undefined;
  const people = () => readPeople(app!.resolved.root);
  /** How the login's pages look: the kit's stylesheet, and the company they are for. */
  const frame = (): PageFrame =>
    app ? { ...(app.stylesheet && { stylesheet: app.stylesheet }), company: companyOf(app.resolved.appName) } : {};
  /** The declared person `identity` names, as admitted, or undefined. */
  const admitted = (identity: LoginIdentity) => {
    try {
      return admit(identity, people(), true);
    } catch {
      return undefined;
    }
  };
  /** Who the half says is signed in, once per request: `handle` asks, then admission. */
  const verified = new WeakMap<Request, Promise<LoginIdentity | undefined>>();
  const identityOf = (request: Request) => {
    let found = verified.get(request);
    if (!found) {
      found = (async () => {
        const session = await half?.verify(request);
        if (!session) return undefined;
        const { email, github } = session;
        return { ...(email && { email }), ...(github && { github }) };
      })();
      verified.set(request, found);
    }
    return found;
  };

  const provider: LoginProvider = {
    name: "staff",
    // The half's (Better Auth's), which the sign-in page posts to as well.
    signOut: "/auth/better-auth/sign-out",
    check() {},
    async open(context) {
      app = context;
      const { client, resolved } = context;
      half = await make({
        databaseUrl: resolved.databaseUrl,
        key: loginKey("staff"),
        secrets: secretValues(client),
        origins: [],
        ...(resolved.login && { sendCode: (email, code) => sendLoginCode(client, email, code) }),
        staff: {
          admits: (identity) => admitted(identity) !== undefined,
          social,
          async record(method, identity) {
            const person = personOf(identity, people().people);
            if (person === undefined) return;
            await client
              .recordSignIn(person, method)
              .catch((err: unknown) => console.error(`sanoma app: ${person}'s sign-in was not recorded:`, err));
          },
        },
      });
    },
    async close() {
      await half?.close?.();
    },
    resolveActor: identityOf,
    async handle(request) {
      if (!half) return smallPage(503, "Starting", "<p>The app is starting. Try again in a moment.</p>");
      const own = await half.handle(request);
      if (own) return own;
      const url = new URL(request.url);
      const { pathname } = url;
      if (pathname === INVITE && request.method === "POST") return mint(request);
      if (pathname.startsWith(`${INVITE}/`) && request.method === "GET")
        return landing(pathname.slice(INVITE.length + 1));
      if (lookFile(pathname, app?.stylesheet)) return undefined;
      const signedIn = await identityOf(request);
      if (pathname === LOGIN && request.method === "GET") {
        // On to the app only for someone it admits: a session of someone no longer declared signs in again here.
        if (signedIn && admitted(signedIn))
          return new Response(null, { status: 302, headers: { location: "/", "cache-control": "no-store" } });
        return signInPage(half, frame(), 200, url.searchParams.get("error"));
      }
      if (signedIn) return undefined;
      return wantsJson(request) ? refuse(401, "Sign in first") : signInPage(half, frame(), 401);
    },
    async invite(email, { origin, by }) {
      if (!half?.invite || !app) throw new Error("The app is starting");
      const person = personOf({ email }, people().people);
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
      const asking = identity && admitted(identity);
      if (!asking) return refuse(401, "Sign in first");
      // An invite signs its holder in as that person: only an admin hands one out.
      if (!asking.groups?.includes(ADMIN)) return refuse(403, `Only someone in ${ADMIN} makes an invite link`);
      ({ email } = body.data);
      by = asking.id;
    }
    if (personOf({ email }, people().people) === undefined) {
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
    const declared = people().people;
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

  return provider;
}

/**
 * Mails a sign-in code, as a run of the built-in `login-code` workflow started by the runtime's
 * agent `login`, the code sealed (`sealLoginCode`): under the policy and in the ledger like any
 * send. What the staff login and every visitor login send their codes with.
 */
export async function sendLoginCode(client: AppContext["client"], email: string, code: string): Promise<void> {
  await client.start(LOGIN_CODE_WORKFLOW, { to: email, code: sealLoginCode(email, code) }, { startedBy: LOGIN_AGENT });
}

/** A refusal of `POST /auth/invite`, as JSON saying why. */
const refuse = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

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
    `<p class="rule">Not ${escapeHtml(person ? firstNameOf(person) : invitation.email)}? <a href="${LOGIN}">Sign in with your own email</a></p>`
  );
}

const GITHUB_ICON = `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/></svg>`;
const CLOCK_ICON = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;

/**
 * What the sign-in page does: it posts JSON to the login's routes (Better Auth's email code and
 * GitHub), says what went wrong by Better Auth's error codes, and once signed in goes back to the
 * page asked for on this host (`/` from the sign-in page itself; leading slashes count as one, so
 * a path like `//elsewhere` never leads off it). A GitHub sign-in that fails comes back to
 * `/auth/login?error=<code>`.
 */
const SIGN_IN_SCRIPT = `
const post=(path,body)=>fetch("/auth/better-auth"+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
const $=(id)=>document.getElementById(id);const message=$("message");const say=(text)=>{message.textContent=text};
const here="/"+location.pathname.replace(/^[/]+/,"");const back=here===${JSON.stringify(LOGIN)}?"/":here+location.search;
const AGAIN="That did not work. Try again in a moment.";let email="";let wrong=0;
const send=()=>post("/email-otp/send-verification-otp",{email,type:"sign-in"}).then((r)=>r.ok,()=>false);
$("email")?.addEventListener("submit",async(e)=>{e.preventDefault();email=String(new FormData(e.target).get("email"));
if(!await send()){say(AGAIN);return}
say("");wrong=0;$("email-step").hidden=true;$("code-step").hidden=false;$("resent").hidden=true;$("code").reset();$("code").querySelector("input").focus()});
$("code")?.addEventListener("submit",async(e)=>{e.preventDefault();
const done=await post("/sign-in/email-otp",{email,otp:String(new FormData(e.target).get("otp"))}).catch(()=>null);
if(done?.ok){location.assign(back);return}
if(!done){say(AGAIN);return}
const {code}=await done.json().catch(()=>({}));
if(code==="OTP_EXPIRED")say("That code has expired. Send a new one.");
else if(code==="TOO_MANY_ATTEMPTS"||++wrong>=3)say("Three wrong codes: send a new one.");
else say("That code did not work. Check it, or send a new one.")});
$("again")?.addEventListener("click",async()=>{if(!await send()){say(AGAIN);return}
say("");wrong=0;$("resent").hidden=false;$("code").reset();$("code").querySelector("input").focus()});
$("different")?.addEventListener("click",()=>{say("");$("code-step").hidden=true;$("email-step").hidden=false;$("email").querySelector("input").focus()});
$("github")?.addEventListener("click",async()=>{
const started=await post("/sign-in/social",{provider:"github",callbackURL:back,errorCallbackURL:${JSON.stringify(LOGIN)}}).then((r)=>r.json()).catch(()=>({}));
if(started.url)location.href=started.url;else say("GitHub sign-in did not start. Try again in a moment.")});
`;
