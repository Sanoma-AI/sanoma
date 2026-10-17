import { tfFake, type TfFakeOptions, type TfFakeState } from "@sanoma-ai/bridge/fake";
import { dockerTf } from "./connector.ts";

export type FakeDockerState = TfFakeState;
export type FakeDockerOptions = TfFakeOptions;

/**
 * A Docker that answers through the real driver over a bridge that creates, changes and deletes
 * containers in memory (`stateBridge`), each as the provider's state holds it, labels included,
 * starting from the replies recorded against local Docker (`@sanoma-ai/bridge`'s `testdata/`).
 * Nothing reaches a Docker daemon.
 */
export function fakeDocker(options: FakeDockerOptions = {}) {
  return tfFake(dockerTf, options);
}
