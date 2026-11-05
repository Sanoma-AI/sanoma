import { defineDriver, DriverError } from "@sanoma-ai/workflows";
import { z } from "zod";
import { agent37Api } from "./api.ts";
import { KEY } from "./backend.ts";
import { agent37Ops } from "./connector.ts";
import { instanceOperations } from "./operations.ts";

export interface Agent37DriverOptions {
  /** How long one request may take, in milliseconds. Default 30 000. */
  timeoutMs?: number;
}

/** The environment variable the driver and the backend read, at each call: declared here, so the connector page asks for it. */
export const agent37Env = z.object({
  [KEY]: z.string().describe("an API key (`sk_live_…`), from Agent37's Cloud API keys page"),
});

/**
 * The instance type's operations, which list the workspace's instances with the key in
 * `AGENT37_API_KEY`, read at each call, so a read says whether the key works. See the README.
 */
export function agent37Driver({ timeoutMs = 30_000 }: Agent37DriverOptions = {}) {
  return defineDriver(
    agent37Ops,
    instanceOperations(() => {
      const key = process.env[KEY];
      if (!key) throw new DriverError(`agent37: ${KEY} is not set`, { retryable: false });
      return agent37Api(key, timeoutMs).list();
    }),
    { env: agent37Env },
  );
}
