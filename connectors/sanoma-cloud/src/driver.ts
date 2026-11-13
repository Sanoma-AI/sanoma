import { createHash } from "node:crypto";
import { type CallContext, cloudRun, defineDriver, DriverError } from "sanoma/workflows";
import { z } from "zod";
import { cloudOps } from "./connector.ts";
import { type CloudApi, cloudOperations, type Company } from "./operations.ts";

export interface CloudDriverOptions {
  /** How long one request may take, in milliseconds. Default 30 000 (a result waits 20 s at most). */
  timeoutMs?: number;
  /** How long a run may take before the call gives up on it, in milliseconds. Default 15 minutes. */
  runTimeoutMs?: number;
}

/** Where Sanoma Cloud's api answers when `SANOMA_CLOUD_URL` is not set. */
const DEFAULT_URL = "https://www.sanoma.work";

/** The secret holding the company's Cloud token, read from the call's secrets on each call. */
const TOKEN = "SANOMA_CLOUD_TOKEN";
/** What a Cloud token looks like: an api token of sanoma-ops's. */
const TOKEN_PATTERN = /^sca_[\w-]+$/;

/** The environment variable the driver reads, on every call. */
const env = z.object({
  SANOMA_CLOUD_URL: z
    .url({ protocol: /^https?$/ })
    .optional()
    .describe(`Where Sanoma Cloud's api answers, ${DEFAULT_URL} unless set`),
});

/**
 * The company's Cloud token, from the call's secrets: stored on this computer when the person
 * signed in to Sanoma, or the host's variable on a Cloud host (its `secrets.ts` binds it). A
 * refusal for none, or a value that is no Cloud token, never saying the value.
 */
async function tokenOf(call: CallContext): Promise<string> {
  const token = await call.secrets.get(TOKEN);
  if (token && TOKEN_PATTERN.test(token)) return token;
  throw new DriverError(
    `Sanoma Cloud: ${TOKEN} ${token ? "is not a Cloud token (sca_…)" : "is not stored"}: sign in to Sanoma on the Hosting page, or paste a Cloud token there`,
    { retryable: false, vendorCode: "no_token" },
  );
}

/** `cloud-available`'s output. */
const Available = z.object({ available: z.boolean(), yours: z.boolean() });

/** `cloud-invite`'s output. */
const Invited = z.object({ url: z.url({ protocol: /^https?$/ }) });

/** `output`, as `schema` reads it, or a refusal saying `workflow` answered something else. */
function answered<T>(workflow: string, schema: z.ZodType<T>, output: unknown): T {
  const parsed = schema.safeParse(output);
  if (parsed.success) return parsed.data;
  throw new DriverError(`Sanoma Cloud: ${workflow}: its answer is not what it should be`, { retryable: false });
}

/** The id a call's start of `workflow` takes: the same for each attempt of the call, so a retry resumes its run. */
const runIdOf = (call: CallContext, workflow: string) =>
  `sanoma-cloud-${createHash("sha256").update(`${call.idempotencyKey}\n${workflow}`).digest("hex").slice(0, 32)}`;

/**
 * Sanoma Cloud's API for one call: sanoma-ops's workflows over its public api (`POST /api/call`),
 * each started (`<workflow>.start`, an id per call, so a retry resumes the same run), then its
 * result read (`<workflow>.result`, 20 s per request, `run_running` until the run ends), with the
 * token as a bearer.
 */
function workflowsApi(call: CallContext, options: CloudDriverOptions): CloudApi {
  /** Read once for the call, when its first run starts. */
  let token: Promise<string> | undefined;
  /** Starts `workflow` with `input` and answers its output once the run ends; a failed run fails the call. */
  const run = (workflow: string, input: unknown, id?: string) =>
    cloudRun(workflow, input, { ...options, token: (token ??= tokenOf(call)), ...(id && { id }) });

  /** A write's run: its id the call's, so each attempt of the call resumes the same run. */
  const resume = (workflow: string, input: unknown) => run(workflow, input, runIdOf(call, workflow));

  return {
    signup: (input) => resume("cloud-signup", input),
    // A read: a retry may start another.
    list: async (input) => {
      const companies = await run("cloud-list", input);
      return Array.isArray(companies) ? (companies as Company[]) : [];
    },
    deploy: (input) => resume("cloud-deploy", input),
    close: (input) => resume("cloud-close", input),
    // Reads, and a link minted again on each try.
    available: async (input) => answered("cloud-available", Available, await run("cloud-available", input)),
    invite: async (input) => answered("cloud-invite", Invited, await run("cloud-invite", input)),
  };
}

/**
 * Sanoma Cloud through sanoma-ops's workflows, at `SANOMA_CLOUD_URL` (www.sanoma.work by default)
 * with the company's `SANOMA_CLOUD_TOKEN` from its secrets, both read when an operation is called.
 * See the README.
 */
export function cloudDriver(options: CloudDriverOptions = {}) {
  return defineDriver(
    cloudOps,
    cloudOperations((call) => workflowsApi(call, options)),
    { env },
  );
}
