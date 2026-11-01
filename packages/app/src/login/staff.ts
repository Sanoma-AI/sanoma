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
  requestOrigin,
  sameOrigin,
  sealLoginCode,
} from "@sanoma-ai/workflows";
import { admit, readPeople } from "@sanoma-ai/workflows/describe";
import { z } from "zod";
import type { AppContext, LoginProvider } from "../context.ts";
import { secretValues } from "../server/secrets.ts";
import { loginKey } from "./keys.ts";
import { escapeHtml, smallPage, wantsJson } from "./page.ts";

// The staff login on a host: a login half (Better Auth's, `betterAuthStaffLogin`) made once the app
// listens, given what only the app has: who the files declare, the sender (a `login-code` run as
// the runtime's agent `login`), the company's GitHub client, and the ledger a sign-in goes to.
// Here too: the sign-in page, an invite's landing page and `POST /auth/invite`.

/** Makes the staff login half from the app's context: `betterAuthStaffLogin`. */
export type MakeStaffLogin = (context: LoginContext) => Promise<LoginHalf>;

/** The company's own OAuth clients, each a sign-in method when given. */
export type StaffSocial = NonNullable<LoginContext["staff"]>["social"];

const INVITE = "/auth/invite";

/** `POST /auth/invite`'s body: a declared colleague's email from someone signed in, or a sealed request (`sealInvite`). */
const InviteBody = z.union([z.object({ email: z.string().email() }), z.object({ request: z.string().min(1) })]);

/**
 * Signs people in with the login half `make` makes (`betterAuthStaffLogin`), once the app listens
 * (`open`): `resolveActor` returns what it verified (`{ email, github }`), which the app matches to
 * a declared person (`admitting`). A request without a session gets the sign-in page (a 401), or
 * JSON for a server function. Besides the half's routes: `GET /auth/invite/<token>`, an invite's
 * landing page, and `POST /auth/invite`, which mints one (`invite`) for `{ email }` from someone
 * signed in, or for `{ request }` sealed under `SANOMA_SIGNING_KEY` (`sealInvite`): `{ url }`.
 */
export function staffLogin(make: MakeStaffLogin, social: StaffSocial = {}): LoginProvider {
  let app: AppContext | undefined;
  let half: LoginHalf | undefined;
  const people = () => readPeople(app!.resolved.root);
  /** The declared person `identity` names, as admitted, or undefined. */
  const admitted = (identity: LoginIdentity) => {
    try {
      return admit(identity, people(), true);
    } catch {
      return undefined;
    }
  };
  /** The nonces of sealed invite requests used, until each expires. */
  const spent = new Map<string, number>();
  /** Marks a sealed request's nonce used; false when it was already. */
  const spend = (nonce: string, exp: number) => {
    const now = Date.now();
    for (const [n, until] of spent) if (until <= now) spent.delete(n);
    if (spent.has(nonce)) return false;
    spent.set(nonce, exp);
    return true;
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
      const { pathname } = new URL(request.url);
      if (pathname === INVITE && request.method === "POST") return mint(request);
      if (pathname.startsWith(`${INVITE}/`) && request.method === "GET")
        return landing(pathname.slice(INVITE.length + 1));
      if (await identityOf(request)) return undefined;
      return wantsJson(request) ? refuse(401, "Sign in first") : signInPage(half);
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
      // Each sealed request mints once: a copy of it, replayed before it expires, mints nothing.
      if (!spend(opened.nonce, opened.exp)) return refuse(403, "That invite request was used already");
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

  /** An invite's landing page: whom it is for and a link that signs them in, so a link preview never uses it up. */
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
      );
    }
    return smallPage(
      200,
      "Invite",
      `<p>This link signs in ${escapeHtml(invitation.email)}, once.</p>` +
        `<p><a href="${escapeHtml(invitation.path)}">Continue as ${escapeHtml(invitation.email)}</a></p>`,
    );
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

/**
 * The sign-in page: an email, then the six-digit code sent to it, and GitHub when the company has
 * a client; one neutral message, whether the email is declared or not. With neither, it says to
 * ask for an invite link and names nothing else: anyone can reach it.
 */
function signInPage(half: LoginHalf): Response {
  const methods = half.methods ?? [];
  const code = methods.includes("code");
  const github = methods.includes("github");
  const forms = [
    code &&
      `<form id="email"><p><label>Work email<br><input type="email" name="email" required autocomplete="email" autofocus></label></p>` +
        `<p><button>Send a code</button></p></form>` +
        `<form id="code" hidden><p id="sent"></p><p><label>Six-digit code<br>` +
        `<input name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code"></label></p>` +
        `<p><button>Sign in</button></p></form>`,
    github && `<p><button id="github" type="button">Sign in with GitHub</button></p>`,
  ].filter(Boolean);
  if (!forms.length) {
    return smallPage(401, "Sign in", "<p>Ask the person who runs this company for an invite link.</p>");
  }
  return smallPage(
    401,
    "Sign in",
    `<h1>Sign in</h1>${forms.join("")}<p id="message" role="status"></p><script>${SIGN_IN_SCRIPT}</script>`,
  );
}

/** What the sign-in page does: it posts JSON to the login's routes, and reloads once signed in. */
const SIGN_IN_SCRIPT = `
const post=(path,body)=>fetch("/auth/better-auth"+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
const message=document.getElementById("message");let email="";
document.getElementById("email")?.addEventListener("submit",async(e)=>{e.preventDefault();email=String(new FormData(e.target).get("email"));
const sent=await post("/email-otp/send-verification-otp",{email,type:"sign-in"}).catch(()=>null);
if(!sent?.ok){message.textContent="That did not work. Try again in a moment.";return}
e.target.hidden=true;const form=document.getElementById("code");form.hidden=false;
document.getElementById("sent").textContent="If "+email+" may sign in here, a code is on its way. It works for five minutes.";form.querySelector("input").focus()});
document.getElementById("code")?.addEventListener("submit",async(e)=>{e.preventDefault();
const done=await post("/sign-in/email-otp",{email,otp:String(new FormData(e.target).get("otp"))}).catch(()=>null);
if(done?.ok)location.reload();else message.textContent="That code did not work. Check it, or send a new one."});
document.getElementById("github")?.addEventListener("click",async()=>{
const started=await post("/sign-in/social",{provider:"github",callbackURL:location.pathname}).then((r)=>r.json()).catch(()=>({}));
if(started.url)location.href=started.url;else message.textContent="GitHub sign-in did not start. Try again in a moment."});
`;
