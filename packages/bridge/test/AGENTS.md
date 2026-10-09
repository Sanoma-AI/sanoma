# packages/bridge/test

Tests for `@sanoma/bridge`. All but `live.test.ts` run offline.

## Contents

| Path                                   | What it is                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [`fake.test.ts`](fake.test.ts)         | `readPins`; the fake over the checked-in GitHub and Stripe fixtures and the errors it gives; no credentials in any fixture             |
| [`errors.test.ts`](errors.test.ts)     | Connect errors and diagnostics as `BridgeError`; `startBridge` without a binary or with one that exits                                 |
| [`record.test.ts`](record.test.ts)     | The recorder's scrubbing, against an in-memory provider, and the fake replaying what it wrote                                          |
| [`tfschema.test.ts`](tfschema.test.ts) | `ctyToZod` per cty type, `generateResources`, `fromTfState` and `toTfState`, and the CLI                                               |
| [`live.test.ts`](live.test.ts)         | `SANOMA_LIVE=1` only: builds the bridge, runs `hashicorp/null` (schema, configure, read, errors), records and replays through the fake |
