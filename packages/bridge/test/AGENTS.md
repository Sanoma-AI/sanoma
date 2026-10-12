# packages/bridge/test

Tests for `@sanoma/bridge`, and the helpers that replay and record the bridge for them. All but `live.test.ts` run offline.

## Contents

| Path                                     | What it is                                                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`fake.test.ts`](fake.test.ts)           | `readPins`; `fakeBridge` over the checked-in GitHub and Stripe fixtures and the errors it gives; a live run without its `needs`; no credentials in any fixture                      |
| [`errors.test.ts`](errors.test.ts)       | Connect errors and diagnostics as `BridgeError`; `startBridge` without a binary or with one that exits                                                                              |
| [`configure.test.ts`](configure.test.ts) | `ensureConfigured`: once per config, close and configure on a change (once for concurrent calls), after `unavailable`, and a retry when not configured                              |
| [`replies.test.ts`](replies.test.ts)     | `loadReplies` (a read without its import too) and `stateBridge`: the bridge's refusals, recorded failures, `gone`                                                                   |
| [`record.test.ts`](record.test.ts)       | The recorder's scrubbing, against an in-memory provider, and `fakeBridge` replaying what it wrote                                                                                   |
| [`tfschema.test.ts`](tfschema.test.ts)   | `ctyToZod` per cty type, `generateResources`, `fromTfState` and `toTfState`, and the CLI                                                                                            |
| [`live.test.ts`](live.test.ts)           | `SANOMA_LIVE=1` only: builds the bridge, runs `hashicorp/null` (schema, configure, read, errors), records and replays through `fakeBridge`                                          |
| [`fake-bridge.ts`](fake-bridge.ts)       | Helper, not published: `fakeBridge`, `BridgeService` over fixture files on an in-memory transport; live (`SANOMA_LIVE=1`, with its `needs`) and recording (`SANOMA_RECORD=1`) modes |
| [`record.ts`](record.ts)                 | Helper, not published: `recorder(dir)`, a Connect interceptor writing scrubbed fixtures                                                                                             |
