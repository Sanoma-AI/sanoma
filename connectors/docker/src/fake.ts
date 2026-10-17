import { tfFake, type TfFakeOptions, type TfFakeState } from "@sanoma-ai/bridge/fake";
import { dockerTf } from "./connector.ts";

/** The replies the fake serves: none recorded yet, so it starts with no containers. */
const fixtures = new URL("../testdata/", import.meta.url);

export type FakeDockerState = TfFakeState;
export type FakeDockerOptions = TfFakeOptions;

/**
 * A Docker that answers through the real driver over a bridge that creates, changes and deletes
 * containers in memory (`stateBridge`), each as the provider's state holds it, its labels
 * included. Nothing reaches a Docker daemon.
 */
export function fakeDocker(options: FakeDockerOptions = {}) {
  return tfFake(dockerTf, { fixtures, ...options });
}
