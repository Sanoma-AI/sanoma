# Working on @sanoma-ai/connector-better-auth

Follow the shared [connector conventions](../AGENTS.md). The [README](README.md) has the key, the schema and the routes a page posts to.

## Contents

| Path                                               | What it is                                                                                                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/connector.ts`](src/connector.ts)             | `betterAuthOps`: no operations, and no driver                                                                                                                                          |
| [`src/instance.ts`](src/instance.ts)               | `openBetterAuth`: one Better Auth instance per protocol on a schema, migrated once per database and schema under an advisory lock; `emailCode`, the email OTP plugin both logins share |
| [`src/login.ts`](src/login.ts)                     | `betterAuthLogin`, the visitor login half; with the company's GitHub client, a visitor links GitHub or signs in with it                                                                |
| [`src/staff.ts`](src/staff.ts)                     | `betterAuthStaffLogin`, the staff sign-in half: declared people only, code, GitHub and invites, its routes allowlisted, POSTs same-origin only                                         |
| [`src/index.ts`](src/index.ts)                     | The package root: `betterAuth` (`withSetup({ login })`), `betterAuthLogin` and `betterAuthStaffLogin`                                                                                  |
| [`test/login.test.ts`](test/login.test.ts)         | The visitor login half on the test database, the email code too, and GitHub (linking, signing in) against a stubbed GitHub                                                             |
| [`test/staff.test.ts`](test/staff.test.ts)         | The staff half: codes to declared emails only, no row for anyone else, invites once, a new one replacing the last, foreign origins and unlisted routes refused                         |
| [`test/connector.test.ts`](test/connector.test.ts) | The fixture company as the app and the SDK read it                                                                                                                                     |
| [`test/site.test.ts`](test/site.test.ts)           | End to end: the fixture built and served, sign-up, the visitor on the page and in a run, the app's host, sign-out                                                                      |
| [`test/fixtures/company/`](test/fixtures/company/) | A company with a public `sites/account` behind this login and a visitors' permit                                                                                                       |

## Boundaries

- Depend on `better-auth` (pinned to `1.7.x`), `pg`, and `kysely` for the `PostgresDialect` that carries `schemaName` (Better Auth's own dependency, the same copy). Nothing under a company's `sites/` imports `better-auth`: pages post JSON to `/auth/better-auth/*`.
- Run the migrations before `betterAuth(options)` (it checks the tables at once), under the advisory lock `hashtext('sanoma.login.better-auth.<schema>')`, polled with `pg_try_advisory_lock` on a session of its own (as the runtime's `lockPreparation`: a blocked lock statement can deadlock with a migration Postgres cannot see), once per database and schema per process: concurrent cold starts fail without the lock, which `login.test.ts` holds it to.
- The staff half answers on any host (`allowedHosts: ["*"]`), which leaves Better Auth's own Origin check nothing to compare: `handle` refuses a POST whose `Origin` is not the request's host itself, and serves only the routes it lists (`ROUTES`).
- Better Auth sets no `input: false` field from a provider's profile (`parseAdditionalUserInputFromProviderProfile`), so `mapProfileToUser` cannot set `github`: the visitor login's account hooks read the login through the GitHub provider's `getUserInfo` with the linked account's own token on GitHub's redirect back (`noteLogin`, `/callback/:id` only), then drop the account's tokens (no GitHub grant is kept), refuse a second GitHub account (`oneGitHub`), and clear the login when the account goes (`forgetLogin`). Keep GitHub an untrusted provider for visitors (`trustedProviders` unset): linking then needs GitHub's verified email, and a GitHub sign-in joins an existing account only when both emails are verified.
- `verify` lets Better Auth's errors for a Host or configuration throw; only a missing or bad cookie is null. `handle` refuses a foreign Host itself (421) before `auth.handler`, which would throw it as a 500.
- Better Auth turns its Origin check off under `NODE_ENV=test` and its rate limit off outside production: the options set both explicitly, so tests run what production runs.

Run `pnpm vitest run connectors/better-auth` with Postgres up (`pnpm db:up`) and the packages built (`site.test.ts` builds the fixture's app against them) and `SANOMA_TEST_DATABASE_URL` naming a database of your own.
