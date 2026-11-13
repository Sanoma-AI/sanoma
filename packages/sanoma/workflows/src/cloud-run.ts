import { z } from "zod";
import { DriverError, retryableStatus } from "./op.ts";
import { apiNameOf, errorMessage, vendorCodeOf } from "./shared.ts";

// A run of one of Sanoma Cloud's workflows (sanoma-ops's) over its public api, as a connector
// calls it: the Sanoma Cloud connector for the company's database and host, the GitHub connector
// for a Cloud company's token.

/** Where Sanoma Cloud's api answers when `SANOMA_CLOUD_URL` is not set. */
const DEFAULT_URL = "https://www.sanoma.work";

/** The secret holding the company's Cloud token. */
export const CLOUD_TOKEN = "SANOMA_CLOUD_TOKEN";

export interface CloudRunOptions {
  /** The company's Cloud token, the requests' bearer. */
  token: string | Promise<string>;
  /** The run's id: the same for each attempt of a call, so a retry resumes its run. Without one each call starts a run. */
  id?: string;
  /** How long one request may take, in milliseconds. Default 30 000 (a result waits 20 s at most). */
  timeoutMs?: number;
  /** How long the run may take before the call gives up on it, in milliseconds. Default 15 minutes. */
  runTimeoutMs?: number;
}

/** An api refusal's body, as the app answers one: `{ error, code? }`. */
const Problem = z.object({ error: z.string(), code: z.string().optional() });

/** A start's answer. */
const Started = z.object({ runId: z.string().min(1) });

/**
 * Starts `workflow` with `input` at Sanoma Cloud and answers its output once the run ends; a failed
 * run fails the call. Over the public api at `SANOMA_CLOUD_URL` (www.sanoma.work unless set),
 * `POST /api/call` with the token as a bearer: `<workflow>.start` (with `id` when given), then
 * `<workflow>.result` (20 s per request, `run_running` until the run ends). Failures are
 * `DriverError`s (`run_running` kept as the `vendorCode`), never saying the token.
 */
export async function cloudRun(
  workflow: string,
  input: unknown,
  { token, id, timeoutMs = 30_000, runTimeoutMs = 15 * 60_000 }: CloudRunOptions,
): Promise<unknown> {
  const at = new URL("/api/call", process.env.SANOMA_CLOUD_URL || DEFAULT_URL);

  /** One request to the api: its answer, or a `DriverError` (`run_running` kept as its `vendorCode`). */
  const send = async (body: { name: string; input?: unknown; id?: string }) => {
    const bearer = await token;
    let res: Response;
    try {
      res = await fetch(at, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json" },
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
        ? `${CLOUD_TOKEN} was refused: it is unknown or revoked`
        : (problem?.error ?? (res.ok ? "the answer is not JSON" : `HTTP ${res.status}`));
    throw new DriverError(`Sanoma Cloud: ${workflow}: ${why}`, {
      retryable: retryableStatus(res.status),
      status: res.status,
      ...(problem?.code && { vendorCode: problem.code }),
    });
  };

  const name = apiNameOf(workflow);
  const started = Started.safeParse(await send({ name: `${name}.start`, input, ...(id && { id }) }));
  if (!started.success)
    throw new DriverError(`Sanoma Cloud: ${workflow}: its start answered no run`, { retryable: false });
  const { runId } = started.data;
  const until = Date.now() + runTimeoutMs;
  for (;;) {
    try {
      return await send({ name: `${name}.result`, input: { runId } });
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
}
