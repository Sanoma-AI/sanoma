import { createHash } from "node:crypto";
import {
  type CallContext,
  defineDriver,
  DriverError,
  errorMessage,
  retryableStatus,
  vendorCodeOf,
} from "sanoma/workflows";
import { apiNameOf } from "sanoma/workflows/shared";
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

/** The environment variables the driver reads, on every call. */
const env = z.object({
  SANOMA_CLOUD_TOKEN: z
    .string()
    .regex(/^sca_[\w-]+$/, "a Cloud token, `sca_…`")
    .describe("The company's Sanoma Cloud token (`sca_…`), shown once when the Sanoma account made it"),
  SANOMA_CLOUD_URL: z
    .url({ protocol: /^https?$/ })
    .optional()
    .describe(`Where Sanoma Cloud's api answers, ${DEFAULT_URL} unless set`),
});

/** An api refusal's body, as the app answers one: `{ error, code? }`. */
const Problem = z.object({ error: z.string(), code: z.string().optional() });

/** A start's answer. */
const Started = z.object({ runId: z.string().min(1) });

/** The id a call's start of `workflow` takes: the same for each attempt of the call, so a retry resumes its run. */
const runIdOf = (call: CallContext, workflow: string) =>
  `sanoma-cloud-${createHash("sha256").update(`${call.idempotencyKey}\n${workflow}`).digest("hex").slice(0, 32)}`;

/**
 * Sanoma Cloud's API for one call: sanoma-ops's workflows over its public api (`POST /api/call`),
 * each started (`<workflow>.start`, an id per call, so a retry resumes the same run), then its
 * result read (`<workflow>.result`, 20 s per request, `run_running` until the run ends), with the
 * token as a bearer.
 */
function workflowsApi(call: CallContext, { timeoutMs, runTimeoutMs }: Required<CloudDriverOptions>): CloudApi {
  const token = process.env.SANOMA_CLOUD_TOKEN;
  if (!token) {
    throw new DriverError(`Sanoma Cloud: SANOMA_CLOUD_TOKEN is not set (${env.shape.SANOMA_CLOUD_TOKEN.description})`, {
      retryable: false,
    });
  }
  const at = new URL("/api/call", process.env.SANOMA_CLOUD_URL || DEFAULT_URL);

  /** One request to the api: its answer, or a `DriverError` (`run_running` kept as its `vendorCode`). */
  const send = async (workflow: string, body: { name: string; input?: unknown; id?: string }) => {
    let res: Response;
    try {
      res = await fetch(at, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        // A redirect is no answer of the api's, and would carry the token elsewhere.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // No answer: the request may or may not have reached the Cloud.
      const timedOut = (error as { name?: string } | null)?.name === "TimeoutError";
      throw new DriverError(
        `Sanoma Cloud: ${workflow}: ${timedOut ? `no reply in ${timeoutMs} ms` : `the request failed (${errorMessage(error)})`}`,
        { retryable: true },
      );
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = undefined;
    }
    if (res.ok && parsed !== undefined) return parsed;
    const problem = Problem.safeParse(parsed).data;
    const why =
      res.status === 401
        ? "SANOMA_CLOUD_TOKEN was refused: it is unknown or revoked"
        : (problem?.error ?? (res.ok ? "the answer is not JSON" : `HTTP ${res.status}`));
    throw new DriverError(`Sanoma Cloud: ${workflow}: ${why}`, {
      retryable: retryableStatus(res.status),
      status: res.status,
      ...(problem?.code && { vendorCode: problem.code }),
    });
  };

  /** Starts `workflow` with `input` and answers its output once the run ends; a failed run fails the call. */
  const run = async (workflow: string, input: unknown, id?: string) => {
    const name = apiNameOf(workflow);
    const started = Started.safeParse(await send(workflow, { name: `${name}.start`, input, ...(id && { id }) }));
    if (!started.success)
      throw new DriverError(`Sanoma Cloud: ${workflow}: its start answered no run`, { retryable: false });
    const { runId } = started.data;
    const until = Date.now() + runTimeoutMs;
    for (;;) {
      try {
        return await send(workflow, { name: `${name}.result`, input: { runId } });
      } catch (error) {
        if (vendorCodeOf(error) !== "run_running") throw error;
        if (Date.now() >= until) {
          // Retried, the call resumes the same run.
          throw new DriverError(`Sanoma Cloud: ${workflow}: run ${runId} has not ended in ${runTimeoutMs} ms`, {
            retryable: true,
          });
        }
      }
    }
  };

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
  };
}

/**
 * Sanoma Cloud through sanoma-ops's workflows, at `SANOMA_CLOUD_URL` (www.sanoma.work by default)
 * with the company's `SANOMA_CLOUD_TOKEN`, both read when an operation is called. See the README.
 */
export function cloudDriver(options: CloudDriverOptions = {}) {
  const settings = { timeoutMs: options.timeoutMs ?? 30_000, runTimeoutMs: options.runTimeoutMs ?? 15 * 60_000 };
  return defineDriver(
    cloudOps,
    cloudOperations((call) => workflowsApi(call, settings)),
    { env },
  );
}
