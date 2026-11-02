# @sanoma-ai/connector-better-auth

[Better Auth](https://www.better-auth.com) as a visitor login for a [Sanoma](https://github.com/Sanoma-AI/sanoma) public site, and as the app's staff sign-in on a host: visitors sign up and sign in with an email and a password (or an email code, or GitHub), staff by an email code, an invite link or GitHub, and the accounts live on the company's own database. It has no operations and no credential; it attaches a login half (`withSetup({ login })`, see [`@sanoma-ai/workflows`](https://www.npmjs.com/package/@sanoma-ai/workflows#usage)), which the app calls once for each public site that names it.

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

### GitHub

When the app has the company's GitHub App client (`SANOMA_GITHUB_CLIENT_ID` and `SANOMA_GITHUB_CLIENT_SECRET`, which `sanoma` reads on a host, the staff login's too), the login offers GitHub (`methods` lists `"github"`): a visitor signed in links their GitHub account, and is then said to be that GitHub login (`ctx.startedBy.github` in a run they start, `user.github` in the session). Add `https://<site host>/auth/better-auth/callback/github` to the App's callback URLs (its settings, "Callback URL"), one for each site's host.

| Route                                   | Body                                  | What it does                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /auth/better-auth/link-social`    | `{ provider: "github", callbackURL }` | Signed in: answers `{ url, redirect: true }`, GitHub's authorize page to send the browser to; back at `/callback/github`, it links the account, then `callbackURL`.                        |
| `POST /auth/better-auth/sign-in/social` | `{ provider: "github", callbackURL }` | The same, signed out: signs in a visitor who linked that GitHub account. GitHub links to an existing account and signs a linked account in; it never makes one (`?error=signup_disabled`). |
| `GET /auth/better-auth/get-session`     |                                       | `{ session, user }`, `user.github` the linked login, or null when signed out.                                                                                                              |

```ts
const response = await fetch("/auth/better-auth/link-social", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ provider: "github", callbackURL: location.pathname }),
});
const { url } = await response.json();
window.location.assign(url); // GitHub, then back on this page with the account linked
```

Each `callbackURL` (and `errorCallbackURL`, where an error goes as `?error=<code>`) is a path on the site's host. A GitHub account links to one visitor only (`?error=account_already_linked_to_different_user` for another), its email may differ from the visitor's, and GitHub must have verified it. The login is GitHub's answer for the account's own token when Better Auth links it (Better Auth sets no field a person may not set from a provider's profile), and is cleared when the visitor unlinks it (`POST /unlink-account { accountId }`, the account's id in `GET /list-accounts`). Linked, the account keeps no GitHub token: its login is read once, at each link or sign-in, and its tokens dropped, as a GitHub App's user token reaches what the App and the person both reach. A visitor links one GitHub account at most (another is `?error=unable_to_link_account`).

## The staff sign-in

`betterAuthStaffLogin` is the app's sign-in for the company's own people on a host, which the `sanoma` bin uses off this machine (`staffLogin(betterAuthStaffLogin, { github })` from `@sanoma-ai/app`). Unlike the visitor login, nobody signs up: a code is sent, and an account made, only for an email the people file declares (anyone else gets the same answer, and nothing is stored or sent), or a GitHub login it declares. Its tables are in the schema `better_auth_staff`, migrated under the advisory lock `sanoma.login.better-auth.better_auth_staff`; its cookie is `sanoma.session_token`, for seven days, on whatever host the app answers on. Its ways in, under `/auth/better-auth/`:

- an email code (`/email-otp/send-verification-otp`, `/sign-in/email-otp`), with a sender;
- GitHub (`/sign-in/social`, back at `/callback/github`), with the company's GitHub App's client, matched by the verified email GitHub gives, else the login;
- an invite (`/magic-link/verify`), a one-use magic link valid 24 hours that the app mints server-side (`invite`), a new one replacing the person's last; Better Auth's own `/sign-in/magic-link` is not served.

Every other Better Auth route is a 404, a POST whose `Origin` is not the request's own host is a 403, and a `callbackURL`, `errorCallbackURL` or `newUserCallbackURL` that is not a path on the request's host is a 400. Invites are minted one at a time. Each sign-in is told to the app (`signin.recorded` in the ledger, with how).

### Later

Password reset for visitors, more social providers (Google), and the rate limit kept in the database for several processes.

The logo the app shows is Better Auth's mark, from the [Better Auth repository](https://github.com/better-auth/better-auth) (`demo/nextjs/components/logo.tsx`), in black or white. It is there only to identify the service.
