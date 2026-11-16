import { defineDriver, DriverError, RUNNER_PORT, RUNNER_PROTOCOL } from "sanoma/workflows";
import { z } from "zod";
import { agent37Api } from "./api.ts";
import {
  type Agent37BackendOptions,
  asleep,
  BOX,
  BUDGET_MS,
  EDGE,
  GROUP,
  holding,
  KEY,
  opening,
  openInstance,
} from "./backend.ts";
import { agent37Ops, wanted } from "./connector.ts";
import { instanceOperations, noBox } from "./operations.ts";

export interface Agent37DriverOptions extends Agent37BackendOptions {
  /** How long one request may take, in milliseconds. Default 30 000. */
  timeoutMs?: number;
}

/** The environment variable the driver and the backend read, at each call: declared here, so the connector page asks for it. */
export const agent37Env = z.object({
  [KEY]: z.string().describe("an API key (`sk_live_…`), from Agent37's Cloud API keys page"),
});

/** An instance's states that do not count toward the workspace's limit of awake instances. */
const RESTING = ["sleeping", "stopped", "failed"];

/** The key in the environment, read at each call. */
const keyOf = () => {
  const key = process.env[KEY];
  if (!key) throw new DriverError(`agent37: ${KEY} is not set`, { retryable: false });
  return key;
};

/**
 * The instance type's operations, which list the workspace's instances, and the boxes', each with
 * the key in `AGENT37_API_KEY`, read at each call, so a read says whether the key works. See the README.
 */
export function agent37Driver({ timeoutMs = 30_000, edge = EDGE, budgetMs = BUDGET_MS }: Agent37DriverOptions = {}) {
  const apiOf = () => agent37Api(keyOf(), timeoutMs);
  return defineDriver(
    agent37Ops,
    {
      ...instanceOperations(() => apiOf().list()),
      box: {
        async open({ name, group, network, ttl }) {
          const key = keyOf();
          const api = agent37Api(key, timeoutMs);
          const id = await openInstance(api, key, { name, want: wanted({}), group, network, edge, budgetMs });
          // The runner answered this release's protocol, or `openInstance` replaced it.
          return { id, ...(await api.signedUrl(id, RUNNER_PORT, ttl)), protocol: RUNNER_PROTOCOL };
        },
        async expose({ name, port, ttl }) {
          const api = apiOf();
          const [found] = await holding(api, BOX, name);
          if (!found) throw noBox(name);
          return api.signedUrl(found.id, port, ttl);
        },
        async sleep({ name }) {
          const api = apiOf();
          const held = await holding(api, BOX, name);
          await Promise.all(held.map(({ id }) => asleep(api, id, Date.now() + budgetMs)));
          return { ids: held.map(({ id }) => id) };
        },
        async discard({ name, group }) {
          // An open in flight here may yet make the box: wait for it, so this removes it.
          if (name !== undefined) await opening.get(name)?.catch(() => undefined);
          const api = apiOf();
          const held = await (name === undefined ? holding(api, GROUP, group!) : holding(api, BOX, name));
          await Promise.all(held.map(({ id }) => api.remove(id)));
          return { ids: held.map(({ id }) => id) };
        },
        async list({ group }) {
          const boxes = await holding(apiOf(), GROUP, group);
          return {
            boxes: boxes.map((i) => ({
              id: i.id,
              name: String(i.metadata?.[BOX]),
              awake: !RESTING.includes(i.status),
            })),
          };
        },
      },
    },
    { env: agent37Env },
  );
}
