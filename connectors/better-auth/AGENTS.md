# Working on @sanoma-ai/connector-better-auth

Follow the shared [connector conventions](../AGENTS.md). The [README](README.md) has the key, the schema and the routes a page posts to.

## Contents

| Path                                               | What it is                                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [`src/connector.ts`](src/connector.ts)             | `betterAuthOps`: no operations, and no driver                                                                     |
| [`src/login.ts`](src/login.ts)                     | `betterAuthLogin`, the login half                                                                                 |
| [`src/index.ts`](src/index.ts)                     | The package root: `betterAuth` (`withSetup({ login })`) and `betterAuthLogin`                                     |
| [`test/login.test.ts`](test/login.test.ts)         | The login half on the test database                                                                               |
| [`test/connector.test.ts`](test/connector.test.ts) | The fixture company as the app and the SDK read it                                                                |
| [`test/site.test.ts`](test/site.test.ts)           | End to end: the fixture built and served, sign-up, the visitor on the page and in a run, the app's host, sign-out |
| [`test/fixtures/company/`](test/fixtures/company/) | A company with a public `sites/account` behind this login and a visitors' permit                                  |

## Boundaries

- Depend on `better-auth` (pinned to `1.7.x`), `pg`, and `kysely` for the `PostgresDialect` that carries `schemaName` (Better Auth's own dependency, the same copy). Nothing under a company's `sites/` imports `better-auth`: pages post JSON to `/auth/better-auth/*`.
- Run the migrations before `betterAuth(options)` (it checks the tables at once), under the advisory lock `hashtext('sanoma.login.better-auth')`, polled with `pg_try_advisory_lock` on a session of its own (as the runtime's `lockPreparation`: a blocked lock statement can deadlock with a migration Postgres cannot see), once per database per process: concurrent cold starts fail without the lock, which `login.test.ts` holds it to.
- `verify` lets Better Auth's errors for a Host or configuration throw; only a missing or bad cookie is null. `handle` refuses a foreign Host itself (421) before `auth.handler`, which would throw it as a 500.
- Better Auth turns its Origin check off under `NODE_ENV=test` and its rate limit off outside production: the options set both explicitly, so tests run what production runs.

Run `pnpm vitest run connectors/better-auth` with Postgres up (`pnpm db:up`) and the packages built (`site.test.ts` builds the fixture's app against them) and `SANOMA_TEST_DATABASE_URL` naming a database of your own.
