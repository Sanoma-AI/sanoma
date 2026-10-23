import { defineDriver, DriverError, retryableStatus } from "@sanoma-ai/workflows";
import type { Exa } from "exa-js";
import { z } from "zod";
import { exaOps } from "./connector.ts";

export interface ExaDriverOptions {
  /** How long one request may take before it fails, retryable. Default 30 seconds: a deep search or an answer takes several. */
  timeoutMs?: number;
}

/** The environment variable the driver reads, on every call. */
const env = z.object({
  EXA_API_KEY: z.string().describe("an API key, from the API Keys page of Exa's dashboard"),
});

/**
 * `exa-js`, loaded at the first call: it brings the OpenAI SDK and zod 3, which a worker that
 * never calls Exa (or the app listing the connector) need not load. It also takes `fetch` as it
 * loads, so a test's replay, listening by then, sees its requests.
 */
const sdk = () => import("exa-js");

/**
 * The DriverError for a call that failed. `exa-js` throws an `ExaError` with Exa's status for a
 * reply (an `ExaTimeoutError`, status 408, past the timeout) and `fetch`'s own error for no reply.
 */
function failure(
  op: string,
  timeoutMs: number,
  ExaError: Awaited<ReturnType<typeof sdk>>["ExaError"],
  error: unknown,
): DriverError {
  if (error instanceof DriverError) return error;
  if (error instanceof ExaError && error.name === "TimeoutError") {
    return new DriverError(`exa: ${op} timed out after ${timeoutMs} ms`, { retryable: true, cause: error });
  }
  if (error instanceof ExaError) {
    const { statusCode: status, message, code } = error;
    // A 429 (rate limit) and a 5xx (overloaded, past its deadline) pass; a 402 (credits or budget spent) does not in a retry's wait.
    return new DriverError(`exa: ${op} failed (${status}): ${message}`, {
      retryable: retryableStatus(status),
      status,
      ...(code === undefined ? {} : { vendorCode: code }),
    });
  }
  return new DriverError(`exa: ${op} got no reply`, { retryable: true, cause: error });
}

/**
 * Calls Exa's search, contents, find-similar and answer endpoints through `exa-js`, Exa's own SDK,
 * with the key in `EXA_API_KEY`, read on every call. Each operation only reads, so a retried call
 * costs credits again and changes nothing.
 */
export function exaDriver(options: ExaDriverOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;

  /** Runs `request` on a client with this call's key, and maps what it throws. */
  async function calling<T>(op: string, request: (exa: Exa) => Promise<T>): Promise<T> {
    const key = process.env.EXA_API_KEY;
    if (!key) throw new DriverError("exa: EXA_API_KEY is not set", { retryable: false });
    const { Exa, ExaError } = await sdk();
    let exa: Exa;
    try {
      // Warnings Exa returns about a request are not the worker's to print.
      exa = new Exa(key, undefined, { timeout: timeoutMs, warnings: "silent" });
    } catch (error) {
      // A key no header can carry, such as one with a newline: a retry would fail alike.
      throw new DriverError(`exa: ${op} could not build its request`, { retryable: false, cause: error });
    }
    try {
      return await request(exa);
    } catch (error) {
      throw failure(op, timeoutMs, ExaError, error);
    }
  }

  return defineDriver(
    exaOps,
    {
      web: {
        // `contents: false` when none is asked for: the SDK would otherwise ask for each page's text.
        search: ({ query, contents, ...rest }) =>
          calling("web.search", async (exa) => ({
            results: (contents
              ? await exa.search(query, { ...rest, contents })
              : await exa.search(query, { ...rest, contents: false })
            ).results,
          })),
        getContents: ({ urls, ...contents }) =>
          calling("web.getContents", async (exa) => {
            const { results, statuses = [] } = await exa.getContents(urls, contents);
            return { results, statuses };
          }),
        // Deprecated in the SDK, which has no other way to find pages like one; the endpoint stands.
        findSimilar: ({ url, contents, ...rest }) =>
          calling("web.findSimilar", async (exa) => ({
            results: (contents
              ? await exa.findSimilar(url, { ...rest, contents })
              : await exa.findSimilar(url, { ...rest, contents: false })
            ).results,
          })),
        answer: ({ query, text }) =>
          calling("web.answer", async (exa) => {
            const { answer, citations } = await exa.answer(query, { text });
            // Text, unless the request sends an `outputSchema`, which this one never does.
            if (typeof answer !== "string") {
              throw new DriverError("exa: web.answer replied without an answer in text", { retryable: false });
            }
            return { answer, citations };
          }),
      },
    },
    { env },
  );
}
