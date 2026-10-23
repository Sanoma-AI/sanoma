---
name: build-connector
description: Build a vendor connector under connectors/, deciding its shape, integration source, credentials, errors, fake, steps and listing in order.
---

# Build a connector

Start with [start-task](../start-task/SKILL.md), then decide each step in order. Copy the closest existing connector's layout rather than inventing one; [connector conventions](../../../connectors/AGENTS.md) hold the shared rules.

1. **Name.** `connectors/<vendor>/`, published as `@sanoma-ai/connector-<vendor>` at `0.1.0`, exporting one constant named for the vendor. Operation ids are `<vendor>.<group>.<name>`, such as `exa.web.search`.
2. **Shape.** Resources: a `tfConnector` record ([github](../../../connectors/github/)). Operations: `defineConnector` ([resend](../../../connectors/resend/)). A login for public sites: `withSetup({ login })` ([better-auth](../../../connectors/better-auth/)).
3. **Integration source.** Take the first that fits in [Integration sources](../../../connectors/AGENTS.md#integration-sources): provider, official SDK ([exa](../../../connectors/exa/src/driver.ts)), generated client ([resend](../../../connectors/resend/openapi-ts.config.ts)), `fetch` ([ghost](../../../connectors/ghost/src/driver.ts)). Write the schemas by hand as a cut of the vendor's own field names.
4. **Effects.** `read` changes nothing at the vendor. Otherwise use `write`, `publish`, `send`, `money` or `access`, by what the policy should see. Mark `idempotent: true` only where a retry cannot repeat the effect: reads, or writes the vendor dedupes on the call's `idempotencyKey`. Add `target` when a policy should decide per object.
5. **Credentials.** Declare them in the driver's `env` ([conventions](../../../connectors/AGENTS.md#shared-connector-conventions)), read when the call runs. Never put a value in a file, a fixture or a test.
6. **Errors.** Map every failure to `DriverError`, keeping the vendor's `status` and its error code as `vendorCode`. Retry 408, 429, 5xx, timeouts and no reply (`retryableStatus`), and nothing that a wait cannot fix, such as spent credits or quota. Give each request a timeout, an option of the driver.
7. **Fake.** `src/fake.ts` with `defineFake`: in-memory, deterministic, no network, holding what the operations create in `state`, and refusing what the vendor refuses. Its defaults match the operation's contract, not the SDK's.
8. **Driver tests.** `test/driver.test.ts` replays fixtures with [`@sanoma-ai/testing/replay`](../../../packages/testing/README.md#replaying-a-vendors-api); `test/replay.ts` holds the shared options and a `scrub` for ids and keys. Record fixtures with `SANOMA_LIVE=1 SANOMA_RECORD=1` and a test account. Without a key, write fixtures from the vendor's docs and say so in the README. An SDK that takes `fetch` as it loads must load at the first call, after replay starts ([exa](../../../connectors/exa/src/driver.ts)).
9. **Steps and features.** Steps named for the vendor ("Exa was searched for {string}") in `src/steps.ts`, and `features/` testing each operation on the fake and the replies, as the [conventions](../../../connectors/AGENTS.md#shared-connector-conventions) say.
10. **Listing.** The `sanoma-connector` keyword and the `sanoma` field in `package.json` ([conventions](../../../connectors/AGENTS.md#shared-connector-conventions)), with the vendor's mark from its brand page; the app lists the connector from npm.
11. **Docs.** Write a README in the shape of [resend's](../../../connectors/resend/README.md): operations, usage, driver, environment, errors, testing, steps and the fake. Add `AGENTS.md`, `src/AGENTS.md` and `test/AGENTS.md`, and a row in [connectors/AGENTS.md](../../../connectors/AGENTS.md#contents) and in the root [README](../../../README.md#contents).
12. **Leave out** what no one needs yet: streaming, webhooks, beta endpoints, the vendor's long tail of options. Name them in one "later" line of the PR, not in code.

Check with `pnpm vitest run connectors/<vendor>`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm build`, then [create-pr](../create-pr/SKILL.md). A new package is published by hand once before release.yml can publish it ([Release](../../../README.md#release)).
