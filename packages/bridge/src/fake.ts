// `@sanoma-ai/bridge/fake`: a connector's fake, `tfFake`, its real driver over a `stateBridge` of the
// replies recorded in `testdata/` (`loadReplies`). Replaying the bridge itself, and recording
// fixtures, are this package's test helpers (`test/fake-bridge.ts`, `test/record.ts`).
export type { FixtureError } from "./fixtures.ts";
export { fixturesDir } from "./pins.ts";
export {
  type BridgeCall,
  type BridgeState,
  loadReplies,
  type StateFailure,
  type StateObject,
  stateBridge,
  type StateTypes,
} from "./replies.ts";
export { type TfFake, tfFake, type TfFakeOptions, type TfFakeState } from "./tffake.ts";
