# @sanoma-ai/connector-better-auth

[Better Auth](https://www.better-auth.com) as a visitor login for a [Sanoma](https://github.com/Sanoma-AI/sanoma) public site: visitors sign up and sign in with an email and a password, and their accounts live on the company's own database. It has no operations and no credential; it attaches a login half (`withSetup({ login })`, see [`@sanoma-ai/workflows`](https://www.npmjs.com/package/@sanoma-ai/workflows#usage)), which the app calls once for each public site that names it.

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

It has no credential. Better Auth signs its cookies with a key the app derives for this login from the deployment's `SANOMA_SECRETS_KEY` (HKDF-SHA256, purpose `login better-auth`), which `sanoma` already sets up; changing that key signs every visitor out.

### The schema

The tables (`user`, `session`, `account`, `verification`) are in the schema `better_auth` on the company's database (`SANOMA_DATABASE_URL`), beside the runtime's own, in queries that name the schema (no `search_path`, which the URL's own `options` could change). The login runs Better Auth's migrations when the app starts, before it serves the site: once per database in a process, under a Postgres advisory lock, so several processes starting at once do not race. A second start changes nothing.

### The routes

The login answers under `/auth/better-auth/` on the site's own host, and nothing else. A site's pages are its sign-in forms, drawn from the kit (`sanoma/ui`), that `fetch` JSON with a POST (the browser adds `Origin`, which Better Auth checks):

| Route                                  | Body                          | What it does                                                             |
| -------------------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `POST /auth/better-auth/sign-up/email` | `{ name, email, password }`   | Makes the account and signs the visitor in (8 characters or more).       |
| `POST /auth/better-auth/sign-in/email` | `{ email, password }`         | Signs in; a wrong email or password is 401.                              |
| `POST /auth/better-auth/sign-out`      | `{}`, or none (the app's own) | Ends the session; it is also `signOut`, which `useActor()` gives a page. |

```ts
const response = await fetch("/auth/better-auth/sign-in/email", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (response.ok) window.location.reload(); // the app reads the new session cookie
```

The session is one cookie, `better-auth.session_token` (`__Secure-better-auth.session_token`, and `Secure`, when the site is served over https): HttpOnly, SameSite=Lax, for the site's host only (no `Domain`), for seven days from sign-in. A request for a host that is not the site's is answered 421. Sign-in and sign-up are rate limited per visitor address (three tries in ten seconds), which the app gives the login in its own header, never from `X-Forwarded-For`. A site never imports `better-auth`: its pages only post to these routes.

### Later

Email verification and password reset (they need a sender, such as Resend), social providers (Google, GitHub), and the rate limit kept in the database for several processes.

The logo the app shows is Better Auth's mark, from the [Better Auth repository](https://github.com/better-auth/better-auth) (`demo/nextjs/components/logo.tsx`), in black or white. It is there only to identify the service.
