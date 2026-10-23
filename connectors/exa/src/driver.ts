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

type Sdk = Awaited<ReturnType<typeof sdk>>;

/**
 * The DriverError for a request that failed. `exa-js` throws an `ExaError` with Exa's status for a
 * reply, an `ExaTimeoutError` (status 408) past the timeout, and `fetch`'s own error for no reply.
 */
function failure(op: string, { ExaError, ExaTimeoutError }: Sdk, error: unknown): DriverError {
  if (error instanceof ExaTimeoutError) {
    return new DriverError(`exa: ${op} timed out after ${error.timeout} ms`, {
      retryable: true,
      status: error.statusCode,
      cause: error,
    });
  }
  if (error instanceof ExaError) {
    const { statusCode: status, message, code } = error;
    // A 429 (rate limit) and a 5xx (overloaded, past its deadline) pass; a 402 (credits or budget spent) does not in a retry's wait.
    // Exa's `tag` is not kept: `exa-js` reads a `code` only from an error object, which these endpoints do not send.
    return new DriverError(`exa: ${op} failed (${status}): ${message}`, {
      retryable: retryableStatus(status),
      status,
      cause: error,
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
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError(`exaDriver: timeoutMs must be a whole number of ms, not ${timeoutMs}`);
  }
  /** The client for the last key read, made again only when `EXA_API_KEY` changes. */
  let client: { key: string; exa: Exa } | undefined;

  /** Sends `request` on a client with the key in `EXA_API_KEY`, and maps what fails. */
  async function calling<T extends object>(op: string, request: (exa: Exa) => Promise<T>): Promise<T> {
    const key = process.env.EXA_API_KEY;
    if (!key) throw new DriverError("exa: EXA_API_KEY is not set", { retryable: false });
    const exaJs = await sdk();
    if (client?.key !== key) {
      try {
        // Warnings Exa returns about a request are not the worker's to print.
        client = { key, exa: new exaJs.Exa(key, undefined, { timeout: timeoutMs, warnings: "silent" }) };
      } catch (error) {
        // A key no header can carry, such as one with a newline: a retry would fail alike.
        throw new DriverError(`exa: ${op} could not build its request`, { retryable: false, cause: error });
      }
    }
    let reply: T | undefined;
    try {
      reply = await request(client.exa);
    } catch (error) {
      throw failure(op, exaJs, error);
    }
    // A 200 with an empty body: Exa answered, so a retry would only spend credits again.
    if (typeof reply !== "object" || reply === null) {
      throw new DriverError(`exa: ${op} replied with no body`, { retryable: false });
    }
    return reply;
  }

  return defineDriver(
    exaOps,
    {
      web: {
        // `contents: false` when none is asked for, as the SDK would otherwise ask for each page's
        // text. Two calls, not `contents ?? false`: the SDK's overloads take each but not the union.
        search: async ({ query, contents, ...rest }) => {
          const { results } = await calling("web.search", (exa) =>
            contents ? exa.search(query, { ...rest, contents }) : exa.search(query, { ...rest, contents: false }),
          );
          return { results };
        },
        getContents: async ({ urls, ...contents }) => {
          const { results, statuses = [] } = await calling("web.getContents", (exa) => exa.getContents(urls, contents));
          return { results, statuses };
        },
        // Deprecated in the SDK, which has no other way to find pages like one; the endpoint stands.
        findSimilar: async ({ url, contents, ...rest }) => {
          const { results } = await calling("web.findSimilar", (exa) =>
            contents ? exa.findSimilar(url, { ...rest, contents }) : exa.findSimilar(url, { ...rest, contents: false }),
          );
          return { results };
        },
        answer: async ({ query, text }) => {
          const { answer, citations } = await calling("web.answer", (exa) => exa.answer(query, { text }));
          // Text, unless the request sends an `outputSchema`, which this one never does.
          if (typeof answer !== "string") {
            throw new DriverError("exa: web.answer replied without an answer in text", { retryable: false });
          }
          return { answer, citations };
        },
      },
    },
    { env },
  );
}
