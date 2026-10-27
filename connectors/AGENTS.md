# connectors

One workspace package per vendor, each built on `@sanoma-ai/workflows`. A connector package exports one constant, the vendor's operations with its live driver, its in-memory fake and its steps for Gherkin tests attached (`withSetup`), so a config names the connector alone. A vendor with an OpenTofu provider (Docker, GitHub, Stripe, Supabase) is one `tfConnector` record from [`@sanoma-ai/bridge/connector`](../packages/bridge/README.md#connectors-for-opentofu-providers) over the types `pnpm generate` writes, which gives its resource types, connector, driver and fake.

## Contents

| Path                                    | What it is                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`anthropic/`](anthropic/AGENTS.md)     | `@sanoma-ai/connector-anthropic`: Anthropic's Claude models (a model half) on the company's key                       |
| [`better-auth/`](better-auth/AGENTS.md) | `@sanoma-ai/connector-better-auth`: Better Auth, a visitor login for public sites, on the company's database          |
| [`bluesky/`](bluesky/AGENTS.md)         | `@sanoma-ai/connector-bluesky`: Bluesky (AT Protocol) post operations and an in-memory fake                           |
| [`cloudflare/`](cloudflare/AGENTS.md)   | `@sanoma-ai/connector-cloudflare`: a Container host that stops when quiet, and its Durable Object alarm that wakes it |
| [`docker/`](docker/AGENTS.md)           | `@sanoma-ai/connector-docker`: the local Docker host, a container that runs the company                               |
| [`exa/`](exa/AGENTS.md)                 | `@sanoma-ai/connector-exa`: Exa web search, page contents, similar pages and answers, and an in-memory fake           |
| [`ghost/`](ghost/AGENTS.md)             | `@sanoma-ai/connector-ghost`: Ghost Admin API post operations and an in-memory fake                                   |
| [`github/`](github/AGENTS.md)           | `@sanoma-ai/connector-github`: GitHub resources read through its OpenTofu provider, and pull requests (a remote half) |
| [`neon/`](neon/AGENTS.md)               | `@sanoma-ai/connector-neon`: Neon projects (the company's database, which pauses and branches), branches and computes |
| [`resend/`](resend/AGENTS.md)           | `@sanoma-ai/connector-resend`: Resend broadcast and email operations and an in-memory fake                            |
| [`stripe/`](stripe/AGENTS.md)           | `@sanoma-ai/connector-stripe`: Stripe resources read through its OpenTofu provider                                    |
| [`supabase/`](supabase/AGENTS.md)       | `@sanoma-ai/connector-supabase`: Supabase projects (OpenTofu provider), pooler and health                             |

## Integration sources

Where a connector's calls come from, in order; the schemas are hand-written Zod in every case, whatever carries the calls:

1. **Resources** (things a company creates and keeps in sync): the vendor's OpenTofu/Terraform provider through the bridge, as a `tfConnector` record (Docker, GitHub, Stripe, Supabase).
2. **Operations**: the vendor's officially supported TypeScript SDK as the transport, when one exists and is maintained (Bluesky's `@atproto/api`, Exa's `exa-js`, Cloudflare's `cloudflare`, which carries its container and alarm resources too: the Worker they run is the package's own code, uploaded with them, and Neon's `@neondatabase/api-client`, which carries its project resource).
3. No official SDK: a client generated from the vendor's published OpenAPI spec with Hey API, pinned to a commit and cut to the operations called, in `src/generated/`, never edited by hand (Resend).
4. Neither: a driver hand-written on `fetch`, the last resort (Ghost).

[build-connector](../.agents/skills/build-connector/SKILL.md) walks through making one.

## Shared connector conventions

Keep vendor I/O and credentials in `src/driver.ts`, and simulated behavior in `src/fake.ts`. Handwritten operation schemas live in `src/connector.ts`, as `<vendor>Ops`; provider-backed connectors derive operations and resources from their `tfConnector` record (also `src/connector.ts`) and generated types. `src/index.ts` exports the one `<vendor>` constant, `withSetup(<vendor>Ops, { driver: <vendor>Driver, fake: fake<Vendor> })` (the record's `.connector` for a provider-backed one); `driver.ts` and `fake.ts` import the definition from `connector.ts`, never from `index.ts`, so there is no import cycle. Follow the package source map. Keep the `./driver` and `./fake` entries for the monorepo's tests; workflows reach a driver only through `ctx`, and the lint refuses those entries in workflow files. A login connector attaches `withSetup({ login })`: its login half (`LoginHalf`, in the [workflows README](../packages/workflows/README.md#usage)), which signs visitors in to a public site. A model connector attaches `withSetup({ model })`: an AI SDK provider over the vendor's adapter, reading its key through `ModelContext.secrets` at each call ([anthropic](anthropic/AGENTS.md)). A git host's connector attaches `withSetup({ remote })`: its remote half (`RemoteHalf`), the pull requests, the `sanoma` status and the webhooks a change goes through, reading its tokens through `RemoteContext.secrets` at each call ([github](github/AGENTS.md)).

Who the vendor is lives in `package.json`, nowhere else: the `sanoma-connector` keyword (how the app finds connectors not installed, on npm) and a `"sanoma": { "title", "logo", "logoDark"? }` field, whose logos are SVG files in the package (one `<svg>` element each, at relative `.svg` paths listed in `files`; the README credits their source). `src/connector.ts` passes `vendorInfo(import.meta.url)` from `@sanoma-ai/workflows` as the connector's info, which reads that field, `name` and `homepage`.

Read credentials from the environment when operations are called, not at import, and declare each variable in the driver's `env` (`defineDriver`'s third argument; a provider-backed driver adds it to the driver `tfConnector` returns), named as in the consumer's `.env.example`, with a one-line `.describe()`. Map vendor failures to `DriverError`, preserving retryability and status. Keep fake behavior aligned with the declared operations and the driver's documented idempotency limits.

A connector may ship steps for Gherkin tests in `src/steps.ts`: `<vendor>Steps = defineSteps("<vendor>", ({ given, then }) => …)` from `@sanoma-ai/workflows`, attached with `withSetup(…, { steps })`, named for the vendor ("a Ghost draft titled {string}") so steps of several connectors combine in one scenario without clashing. Keep them pure (a `given` returns seeds, a `then` an `Expect` whose `check` reads the run), never import Cucumber, and never import `@sanoma-ai/workflows/scenario` or faker there: the package root loads them. Its own feature files go in `features/` (in `package.json`'s `files`) and test its operations with those steps and the generic ones (`{op} is called with`, `it returns`, `it fails with status {int}`); `test/features.test.ts` runs them with `describeFeatures` from `@sanoma-ai/testing/features`, on the fake and on the driver over the fixture named after each scenario, with the driver tests' replay options (`test/replay.ts`). A check must hold on both targets: use names (`as`, `$draft.id`) and stable fields, not ids. Record a scenario's fixture with `SANOMA_LIVE=1 SANOMA_RECORD=1` on the features test; tag one no recording can hold `@fake-only`. Driver transport behavior (tokens, retries, collisions) stays in `driver.test.ts`.

Driver tests use HTTP replay or a provider state bridge with fixtures by default. Live/recording runs can publish posts or send emails; use them only when the task calls for live vendor work. Before changing fixtures, read [HTTP replay modes](../packages/testing/README.md#replaying-a-vendors-api) for handwritten drivers or [bridge replay](../packages/bridge/README.md#the-fake) for provider-backed drivers. Run `pnpm typecheck` when changing connector schemas or exports, and the affected package's replay tests for driver changes.
