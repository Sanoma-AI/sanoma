# @sanoma-ai/connector-better-auth

[Better Auth](https://www.better-auth.com) as a visitor login for a [Sanoma](https://github.com/Sanoma-AI/sanoma) public site, and as the app's staff sign-in on a host: visitors sign up and sign in with an email and a password, an email code or GitHub, staff by an email code, an invite link or GitHub, and the accounts live on the company's own database. It has no operations and no credential; it attaches a login half (`withSetup({ login })`, see [`@sanoma-ai/workflows`](https://www.npmjs.com/package/@sanoma-ai/workflows#usage)), which the app calls once for each public site that names it.

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

The tables (`user`, `session`, `account`, `verification`, and `rate_limit`, the rate limit's counts; snake_case columns, as the runtime's own tables) are in the schema `better_auth` on the company's database (`SANOMA_DATABASE_URL`), beside the runtime's own, in queries that name the schema (no `search_path`, which the URL's own `options` could change), reached through the pool the app gives the login (`LoginContext.database`: the app's one pool on Node, the request's own on a Worker, with one Better Auth instance per pool and nothing else kept across requests). The worker makes them at its start, as it makes the runtime's own tables: `prepareBetterAuth`, the connector's `prepare`, applies the migrations the package ships (its `drizzle/` folder, generated from the tables' declaration, recorded in the journal table `drizzle.__drizzle_migrations_better_auth`) on the database's direct URL under the runtime's preparation lock, so two workers starting at once do not race, and a second run changes nothing; the `sanoma` bin's worker runs `prepareBetterAuthStaff` the same way for the staff sign-in's schema, which no config names. The app never migrates: a login whose first request finds a database the worker has not prepared yet, or has prepared for an older version, waits a minute for a worker starting beside the app, then refuses, saying so (start the worker first, or with it). The worker trusts the journal, as it does for the runtime's own tables: to reset a login, drop its schema and its journal table together (`DROP SCHEMA better_auth CASCADE; DROP TABLE drizzle.__drizzle_migrations_better_auth;`), and the next worker makes both again. A schema a release before this one made (on Better Auth's own migrations, whose columns are named otherwise) has no journal: the worker refuses it, naming the drop, and its users sign in again. Nothing of the session is cached in the cookie: every request reads its session row, so a revoked session is gone at once.

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

The session is one cookie, `better-auth.session_token` (`__Secure-better-auth.session_token`, and `Secure`, when the site is served over https): HttpOnly, SameSite=Lax, for the site's host only (no `Domain`), for seven days from sign-in. A request for a host that is not the site's is answered 421. Sign-in and sign-up are rate limited per visitor address (three tries in ten seconds), which the app gives the login in its own header, never from `X-Forwarded-For`; the counts are rows in the schema's `rateLimit` table, so the limit holds across processes and requests. A site never imports `better-auth`: its pages only post to these routes.

### An email code

When the company's config names a sender (`login: { sender: resend.emails.send, from: "Acme <login@acme.example>" }`), the login also signs visitors in by a code mailed to them, sent as a run of the runtime's `login-code` workflow (under the policy and in the ledger). A visitor signed in by code has a verified email, which the app gives the principal (`ctx.startedBy.email` in a run they start); one signed up by password has none until they verify it.

### GitHub

When the app has the company's GitHub App client (`SANOMA_GITHUB_CLIENT_ID` and `SANOMA_GITHUB_CLIENT_SECRET`, which `sanoma` reads on a host, the staff login's too), the login offers GitHub (`methods` lists `"github"`): a visitor signs up or in with GitHub ("Continue with GitHub", beside the email code), or, signed in, links their GitHub account, and is then said to be that GitHub login (`ctx.startedBy.github` in a run they start, `user.github` in the session). Add `https://<site host>/auth/better-auth/callback/github` to the App's callback URLs (its settings, "Callback URL"), one for each site's host; signing in and linking come back to the same one.

| Route                                   | Body                                  | What it does                                                                                                                                                                                  |
| --------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/better-auth/sign-in/social` | `{ provider: "github", callbackURL }` | Answers `{ url, redirect: true }`, GitHub's authorize page to send the browser to; back at `/callback/github`, it signs the visitor in (making the account on first use), then `callbackURL`. |
| `POST /auth/better-auth/link-social`    | `{ provider: "github", callbackURL }` | The same, signed in: links the GitHub account to the visitor's, then `callbackURL`.                                                                                                           |
| `GET /auth/better-auth/get-session`     |                                       | `{ session, user }`, `user.github` the GitHub login, or null when signed out.                                                                                                                 |

```ts
// "Continue with GitHub" on the sign-in page, when the login offers it
const response = await fetch("/auth/better-auth/sign-in/social", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ provider: "github", callbackURL: location.pathname }),
});
const { url } = await response.json();
window.location.assign(url); // GitHub, then back on this page signed in
```

Each `callbackURL` (and `errorCallbackURL`, where an error goes as `?error=<code>`, and `newUserCallbackURL`, where a new account goes) is a path on the site's host.

- **One person, one account.** A GitHub sign-in whose email matches a visitor's account signs into that account when GitHub verified the email and the account's own is verified (by a code, or by GitHub at sign-up); otherwise it is refused, so an email nobody proved never joins someone's account.
- **A new account by GitHub** has its email verified only when GitHub verified it, and `verify` says the email only then. An email code to that address later proves it, and drops the GitHub account that had not.
- **A link** may use a GitHub account of another email, which GitHub must have verified.
- **The login** is GitHub's answer for the account's own token at each sign-in or link (Better Auth sets no field a person may not set from a provider's profile), and is cleared when the visitor unlinks it (`POST /unlink-account { accountId }`, the account's id in `GET /list-accounts`). The account's tokens are dropped then, as a GitHub App's user token reaches what the App and the person both reach.

| `?error=`                                  | When                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `account_not_linked`                       | A sign-in's email matches an account, but one side has not verified it.                                                          |
| `account_already_linked_to_different_user` | A link of a GitHub account that is another visitor's.                                                                            |
| `unable_to_link_account`                   | A second GitHub account for a visitor who has one (by link or by sign-in), or a link whose GitHub email GitHub has not verified. |

## The staff sign-in

`betterAuthStaffLogin` is the app's sign-in for the company's own people on a host, which the `sanoma` bin uses off this machine (`staffLogin(betterAuthStaffLogin, { github })` from `@sanoma-ai/app`). Unlike the visitor login, nobody signs up: a code is sent, and an account made, only for an email the people file declares (anyone else gets the same answer, and nothing is stored or sent), or a GitHub login it declares. Its tables are in the schema `better_auth_staff`, which the worker makes beside `better_auth` ([the schema](#the-schema)); its cookie is `sanoma.session_token`, for seven days, on whatever host the app answers on. Its ways in, under `/auth/better-auth/`:

- an email code (`/email-otp/send-verification-otp`, `/sign-in/email-otp`), with a sender;
- GitHub (`/sign-in/social`, back at `/callback/github`), with the company's GitHub App's client, matched by the verified email GitHub gives, else the login (GitHub's `/user` for the sign-in's own token, which is then dropped; the App needs the account permission "Email addresses: read", or a private email ends in Better Auth's `?error=email_not_found`); a GitHub account the files declare by neither is refused as `?error=not_declared` (or, when its unverified email is a row's, Better Auth's `account_not_linked`), with no row left, as is a new GitHub account under a login a row already carries, since GitHub frees a renamed login; declare people by email where you can;
- an invite (`/magic-link/verify`), a one-use magic link valid 24 hours that the app mints server-side (`invite`), a new one replacing the person's last; Better Auth's own `/sign-in/magic-link` is not served.

Every other Better Auth route is a 404, a POST whose `Origin` is not the request's own host is a 403, and a `callbackURL`, `errorCallbackURL` or `newUserCallbackURL` that is not a path on the request's host is a 400. Invites for one email are minted one at a time, whichever process asks (a lock on the database). Each sign-in is told to the app (`signin.recorded` in the ledger, with how).

### Later

Password reset for visitors, and more social providers (Google).

The logo the app shows is Better Auth's mark, from the [Better Auth repository](https://github.com/better-auth/better-auth) (`demo/nextjs/components/logo.tsx`), in black or white. It is there only to identify the service.
