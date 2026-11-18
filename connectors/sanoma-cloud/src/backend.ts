import { setTimeout as delay } from "node:timers/promises";
import { DriverError, RUNNER_PROTOCOL, runnerBox, type SandboxBackend } from "sanoma/workflows";
import type { CloudApi } from "./operations.ts";

// The `Sandbox` backend on Sanoma Cloud: the company's boxes are Agent37 instances in Sanoma's
// account, whose key only sanoma-ops holds. Its `cloud-box-*` workflows, started with the company's
// Cloud token, find or make the box, wake it and start Sanoma's runner in it, and hand back a
// short-lived link to one of its ports (the runner's, or one `expose` asks for), which reaches it
// with no credential. The instance then talks to its box directly over that link (`runnerBox`):
// nothing is relayed through Sanoma. The image, the size and the limits are the Cloud's.

/** How long `stop` waits for the runner to kill what runs in the box, in ms, before the box sleeps anyway. */
const STOP_MS = 30_000;

/**
 * Why a box whose runner speaks `protocol` is refused: this release's client speaks
 * `RUNNER_PROTOCOL`, and the Cloud starts the runner of sanoma-ops's own release.
 */
const otherProtocol = (protocol: number) =>
  new DriverError(
    protocol > RUNNER_PROTOCOL
      ? `Sanoma Cloud's agent box runs a newer Sanoma than this company (runner protocol ${protocol}, not ${RUNNER_PROTOCOL}): update the company's sanoma package`
      : `Sanoma Cloud's agent box runs an older Sanoma than this company (runner protocol ${protocol}, not ${RUNNER_PROTOCOL}): Sanoma Cloud has not moved to this release yet, so try again later`,
    { retryable: false, vendorCode: "protocol" },
  );

/**
 * The company's boxes at Sanoma Cloud, through `cloud`, its API with the company's Cloud token:
 * `open` starts `cloud-box-open` with the box's name and the hosts it may reach, refuses a runner
 * of another protocol than this release's, and drives the box through the link it answers; a
 * box's `expose` starts `cloud-box-expose`, its `stop` kills what runs in it, then starts
 * `cloud-box-stop`; `discard` starts `cloud-box-discard`. Each is safe to call again: the Cloud
 * opens one box of a name at a time and finds the one there.
 */
export function cloudBackend(cloud: CloudApi): SandboxBackend {
  return {
    async open({ name, hosts }) {
      const { id, url, protocol } = await cloud.boxOpen({ name, hosts });
      if (protocol !== RUNNER_PROTOCOL) throw otherProtocol(protocol);
      const { stop, ...box } = runnerBox({ url, id });
      return {
        ...box,
        expose: async (port) => ({ url: (await cloud.boxExpose({ name, port })).url }),
        async stop() {
          // What runs in it is killed first, which a sleep would keep; a runner that cannot be
          // reached, or does not answer in time, kills nothing, and the sleep goes ahead.
          await Promise.race([stop().catch(() => undefined), delay(STOP_MS, undefined, { ref: false })]);
          await cloud.boxStop({ name });
        },
      };
    },
    async discard({ name }) {
      await cloud.boxDiscard({ name });
    },
  };
}
