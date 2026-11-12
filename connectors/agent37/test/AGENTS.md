# connectors/agent37/test

Tests for the Agent37 connector. None needs an account; `live.ts` is run by hand against one.

## Contents

| Path                                 | What it is                                                                                                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`fixtures/`](fixtures/)             | Agent37's replies the driver's tests replay, written from its documentation                                                                                                                                      |
| [`replay.ts`](replay.ts)             | How Agent37's replies are replayed and recorded (`replayOptions`)                                                                                                                                                |
| [`driver.test.ts`](driver.test.ts)   | The instance type's declaration and operations, the driver's request and its errors, and the fake                                                                                                                |
| [`vendor.ts`](vendor.ts)             | Agent37 on this machine: its API from memory as a `fetch` (its workspace templates too), its exec run here (a template's `PATH`, with no pnpm), its edge this machine's ports                                    |
| [`backend.test.ts`](backend.test.ts) | `agent37Backend` against `vendor.ts`: the conformance kit, the create, a wake, a refused sleep, the runner's start, the pnpm it puts in, the box image's template (registered, found, refused, a declared image) |
| [`live.ts`](live.ts)                 | By hand: a box's times (create, `pnpm install`, checkpoint, wake) and the kit, against a real workspace                                                                                                          |
