# @sanoma-ai/connector-better-auth

[Better Auth](https://www.better-auth.com) as a visitor login for a [Sanoma](https://github.com/Sanoma-AI/sanoma) public site, and as the app's staff sign-in on a host: visitors sign up and sign in with an email and a password (or an email code), staff by an email code, an invite link or GitHub, and the accounts live on the company's own database. It has no operations and no credential; it attaches a login half (`withSetup({ login })`, see [`@sanoma-ai/workflows`](https://www.npmjs.com/package/@sanoma-ai/workflows#usage)), which the app calls once for each public site that names it.

## Usage

```sh
npm install @sanoma-ai/connector-better-auth
```

```ts
// sanoma.config.ts
import { betterAuth } from "@sanoma-ai/connector-better-auth";

export default defineConfig({ workflows, connectors: [betterAuth] });
```

```ts
// sites/account/site.ts
import { defineSite } from "sanoma/site";

export default defineSite({ title: "Account", public: true, login: "better-auth" });
```

A visitor who signs in is the principal `visitor:better-auth:<id>`, in the group `visitors`, where `<id>` is Better Auth's user id; the app makes the principal, never the connector. What a visitor may do is a Cedar `permit` naming that group:

```cedar
// policies/visitors.cedar
permit (principal in Sanoma::Group::"visitors", action == Sanoma::Action::"workflow:hello", resource);
```

### No secret to set

It has no credential. Better Auth signs its cookies with a key the app derives for this login from the deployment's `SANOMA_SIGNING_KEY` (HKDF-SHA256, purpose `login better-auth`), which `sanoma` already sets up; changing that key signs every visitor out.

### The schema

The tables (`user`, `session`, `account`, `verification`) are in the schema `better_auth` on the company's database (`SANOMA_DATABASE_URL`), beside the runtime's own, in queries that name the schema (no `search_path`, which the URL's own `options` could change). The login runs Better Auth's migrations when the app starts, before it serves the site: once per database in a process, under a Postgres advisory lock, so several processes starting at once do not race. A second start changes nothing.

### The routes

The login answers under `/auth/better-auth/` on the site's own host, and nothing else. A site's pages are its sign-in forms, drawn from the kit (`sanoma/ui`), that `fetch` JSON with a POST (the browser adds `Origin`, which Better Auth checks):

| Route                                                    | Body                          | What it does                                                                       |
| -------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| `POST /auth/better-auth/sign-up/email`                   | `{ name, email, password }`   | Makes the account and signs the visitor in (8 characters or more).                 |
| `POST /auth/better-auth/sign-in/email`                   | `{ email, password }`         | Signs in; a wrong email or password is 401.                                        |
| `POST /auth/better-auth/sign-out`                        | `{}`, or none (the app's own) | Ends the session; it is also `signOut`, which `useActor()` gives a page.           |
| `POST /auth/better-auth/email-otp/send-verification-otp` | `{ email, type: "sign-in" }`  | With a sender only: mails a six-digit code, good for five minutes and three tries. |
| `POST /auth/better-auth/sign-in/email-otp`               | `{ email, otp }`              | With a sender only: signs in by the code, making the account on first use.         |

```ts
const response = await fetch("/auth/better-auth/sign-in/email", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (response.ok) window.location.reload(); // the app reads the new session cookie
```

The session is one cookie, `better-auth.session_token` (`__Secure-better-auth.session_token`, and `Secure`, when the site is served over https): HttpOnly, SameSite=Lax, for the site's host only (no `Domain`), for seven days from sign-in. A request for a host that is not the site's is answered 421. Sign-in and sign-up are rate limited per visitor address (three tries in ten seconds), which the app gives the login in its own header, never from `X-Forwarded-For`. A site never imports `better-auth`: its pages only post to these routes.

### An email code

When the company's config names a sender (`login: { sender: resend.emails.send }`), the login also signs visitors in by a code mailed to them, sent as a run of the runtime's `login-code` workflow (under the policy and in the ledger). A visitor signed in by code has a verified email, which the app gives the principal (`ctx.startedBy.email` in a run they start); one signed up by password has none until they verify it.

## The staff sign-in

`betterAuthStaffLogin` is the app's sign-in for the company's own people on a host, which the `sanoma` bin uses off this machine (`staffLogin(betterAuthStaffLogin, { github })` from `@sanoma-ai/app`). Unlike the visitor login, nobody signs up: a code is sent, and an account made, only for an email the people file declares (anyone else gets the same answer, and nothing is stored or sent), or a GitHub login it declares. Its tables are in the schema `better_auth_staff`, migrated under the advisory lock `sanoma.login.better-auth.better_auth_staff`; its cookie is `sanoma.session_token`, for seven days, on whatever host the app answers on. Its ways in, under `/auth/better-auth/`:

- an email code (`/email-otp/send-verification-otp`, `/sign-in/email-otp`), with a sender;
- GitHub (`/sign-in/social`, back at `/callback/github`), with the company's GitHub App's client, matched by the verified email GitHub gives, else the login;
- an invite (`/magic-link/verify`), a one-use magic link valid 24 hours that the app mints server-side (`invite`), a new one replacing the person's last; Better Auth's own `/sign-in/magic-link` is not served.

Every other Better Auth route is a 404, and a POST whose `Origin` is not the request's own host is a 403. Each sign-in is told to the app (`signin.recorded` in the ledger, with how).

### Later

Password reset for visitors, more social providers (Google), and the rate limit kept in the database for several processes.

The logo the app shows is Better Auth's mark, from the [Better Auth repository](https://github.com/better-auth/better-auth) (`demo/nextjs/components/logo.tsx`), in black or white. It is there only to identify the service.
