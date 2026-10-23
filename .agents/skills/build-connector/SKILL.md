---
name: build-connector
description: Build a vendor connector under connectors/, deciding its shape, integration source, credentials, errors, fake, steps and listing in order.
---

# Build a connector

Start with [start-task](../start-task/SKILL.md), then decide each step in order. Copy the closest existing connector's layout rather than inventing one; [connector conventions](../../../connectors/AGENTS.md) hold the shared rules.

1. **Name.** `connectors/<vendor>/`, published as `@sanoma-ai/connector-<vendor>` at `0.1.0`, exporting one constant named for the vendor. Operation ids are `<vendor>.<group>.<name>`, such as `exa.web.search`.
2. **Shape.** Things a company creates and keeps in sync are resources. Calls that read or act once are operations. A login connector signs visitors in to a public site. Resources: a `tfConnector` record ([github](../../../connectors/github/)). Operations: `defineConnector` ([resend](../../../connectors/resend/)). Login: `withSetup({ login })` ([better-auth](../../../connectors/better-auth/)).
3. **Integration source,** in the order in [Integration sources](../../../connectors/AGENTS.md#integration-sources):
   - Resources come from the vendor's OpenTofu provider through the bridge.
   - Operations go through the vendor's official, maintained TypeScript SDK ([exa](../../../connectors/exa/src/driver.ts), [bluesky](../../../connectors/bluesky/src/driver.ts)).
   - Without an SDK, a client generated from the vendor's OpenAPI spec ([resend](../../../connectors/resend/openapi-ts.config.ts)).
   - With neither, `fetch` ([ghost](../../../connectors/ghost/src/driver.ts)).
   - Write the Zod schemas by hand in `src/connector.ts` in every case, as a cut of the vendor's own field names.
4. **Effects.** `read` changes nothing at the vendor. Otherwise use `write`, `publish`, `send`, `money` or `access`, by what the policy should see. Mark `idempotent: true` only where a retry cannot repeat the effect: reads, or writes the vendor dedupes on the call's `idempotencyKey`. Add `target` when a policy should decide per object.
5. **Credentials.** Declare each variable in the driver's `env` with a one-line `.describe()`, and read it when the call runs, never at import. A missing one fails, not retryable, naming it. Never put a value in a file, a fixture or a test.
6. **Errors.** Map every failure to `DriverError`, keeping the vendor's `status` and its error code as `vendorCode`. Retry 408, 429, 5xx, timeouts and no reply (`retryableStatus`), and nothing that a wait cannot fix, such as spent credits or quota. Give each request a timeout, an option of the driver.
7. **Fake.** `src/fake.ts` with `defineFake`: in-memory, deterministic, no network, holding what the operations create in `state`, and refusing what the vendor refuses. Its defaults match the operation's contract, not the SDK's.
8. **Driver tests.** `test/driver.test.ts` replays fixtures with [`@sanoma-ai/testing/replay`](../../../packages/testing/README.md#replaying-a-vendors-api); `test/replay.ts` holds the shared options and a `scrub` for ids and keys. Record fixtures with `SANOMA_LIVE=1 SANOMA_RECORD=1` and a test account. Without a key, write fixtures from the vendor's docs and say so in the README. Load an SDK that captures `fetch` at the first call, not at import, so replay sees its requests.
9. **Steps and features.** `src/steps.ts` uses `defineSteps("<vendor>", …)` with steps named for the vendor ("Exa was searched for {string}"). `features/` tests each operation on the fake and on the replies; run it from `test/features.test.ts` with `describeFeatures`, and tag a scenario no recording holds `@fake-only`.
10. **Listing.** In `package.json`, add the `sanoma-connector` keyword, `"sanoma": { "title", "logo", "logoDark" }` with the vendor's mark as one-element SVGs from its brand page, and the logos in `files`. The README credits the logos' source. `vendorInfo(import.meta.url)` reads them, and the app lists the connector from npm.
11. **Docs.** Write a README in the shape of [resend's](../../../connectors/resend/README.md): operations, usage, driver, environment, errors, testing, steps and the fake. Add `AGENTS.md`, `src/AGENTS.md` and `test/AGENTS.md`, and a row in [connectors/AGENTS.md](../../../connectors/AGENTS.md#contents) and in the root [README](../../../README.md#contents).
12. **Leave out** what no one needs yet: streaming, webhooks, beta endpoints, the vendor's long tail of options. Name them in one "later" line of the PR, not in code.

Check with `pnpm vitest run connectors/<vendor>`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm build`, then [create-pr](../create-pr/SKILL.md). A new package is published by hand once before release.yml can publish it ([Release](../../../README.md#release)).
