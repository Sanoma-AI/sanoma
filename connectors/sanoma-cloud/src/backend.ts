import { DriverError, RUNNER_PROTOCOL, runnerBox, type SandboxBackend } from "sanoma/workflows";
import type { z } from "zod";
import { BOX_INPUTS, boxProblem, type CloudApi } from "./operations.ts";

// The `Sandbox` backend on Sanoma Cloud: the company's boxes are Agent37 instances in Sanoma's
// account, whose key only sanoma-ops holds. Its `cloud-box-*` workflows, started with the company's
// Cloud token, find or make the box, wake it and start Sanoma's runner in it, and hand back a
// short-lived link to one of its ports (the runner's, or one `expose` asks for), which reaches it
// with no credential. The instance then talks to its box directly over that link (`runnerBox`):
// nothing is relayed through Sanoma. The image, the size and the limits are the Cloud's.

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

/** `input`, refused (`invalid_box`) before any workflow starts when the Cloud would refuse it (`BOX_INPUTS`). */
function checked<T>(schema: z.ZodType<T>, input: T): T {
  const problem = boxProblem(schema, input);
  if (problem)
    throw new DriverError(`Sanoma Cloud's agent box: ${problem}`, { retryable: false, vendorCode: "invalid_box" });
  return input;
}

/**
 * The company's boxes at Sanoma Cloud, through `cloud`, its API with the company's Cloud token:
 * `open` starts `cloud-box-open` with the box's name and the hosts it may reach, refuses a runner
 * of another protocol than this release's, and drives the box through the link it answers, its
 * `stop` putting it to sleep with `cloud-box-stop` once the runner has killed what runs in it; a
 * box's `expose` starts `cloud-box-expose`; `discard` starts `cloud-box-discard`. A name or a host
 * the Cloud would refuse is refused first. Each is safe to call again: the Cloud opens one box of a
 * name at a time and finds the one there.
 */
export function cloudBackend(cloud: CloudApi): SandboxBackend {
  return {
    async open({ name, hosts }) {
      const { id, url, protocol } = await cloud.boxOpen(checked(BOX_INPUTS.open, { name, hosts }));
      if (protocol !== RUNNER_PROTOCOL) throw otherProtocol(protocol);
      return {
        ...runnerBox({ url, id, sleep: () => cloud.boxStop({ name }) }),
        expose: async (port) => ({ url: (await cloud.boxExpose({ name, port })).url }),
      };
    },
    async discard({ name }) {
      await cloud.boxDiscard(checked(BOX_INPUTS.name, { name }));
    },
  };
}
