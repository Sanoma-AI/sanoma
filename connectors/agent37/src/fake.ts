import { RUNNER_PORT, RUNNER_PROTOCOL } from "sanoma/workflows";
import { defineFake, type FakeOptions } from "sanoma/workflows/fake";
import { z } from "zod";
import { agent37Ops } from "./connector.ts";
import { EDGE } from "./backend.ts";
import { instanceLimitReached, instanceOperations, noBox, otherGroup } from "./operations.ts";

interface FakeBox {
  id: string;
  name: string;
  group: string;
  awake: boolean;
}

export interface FakeAgent37Options extends FakeOptions {
  /**
   * How many instances the workspace keeps awake at once: waking one more is refused with `409`
   * `instance_limit_reached`, as Agent37's limit is. Default no limit; `agent37Steps`' step sets it.
   */
  instanceLimit?: number;
}

/** The workspace's settings, as `put("workspace", …)` takes them: what a scenario's step seeds. */
const Workspace = z.strictObject({ instanceLimit: z.number().int().nonnegative() });

/** Throws for any resource but the workspace's settings, the one the fake holds. */
const onlyWorkspace = (type: string) => {
  if (type !== "workspace") throw new Error(`fake agent37 holds the workspace's settings alone, not a ${type}`);
};

/**
 * An Agent37 whose key works: it holds no instances for the instance type's operations, and its
 * boxes in memory, made by `box.open`, up to `instanceLimit` awake. Its `put("workspace", id,
 * { instanceLimit })` sets the limit and `remove("workspace", id)` lifts it (a scenario's
 * `Given Agent37's workspace keeps at most {int} instances awake`); it holds no other resource.
 */
export function fakeAgent37({ instanceLimit, ...options }: FakeAgent37Options = {}) {
  const fake = defineFake(
    agent37Ops,
    {
      initial: () => ({ seq: 0, boxes: [] as FakeBox[], instanceLimit }),
      ops: (state) => {
        const named = (name: string) => state.boxes.find((box) => box.name === name);
        /** A link to the box `id`'s `port` for `ttl` seconds, as Agent37 mints one. */
        const link = (id: string, port: number, ttl: number) => ({
          url: `${EDGE(id, port)}/?a37_token=token-${++state.seq}`,
          expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        });
        return {
          ...instanceOperations(async () => []),
          box: {
            async open({ name, group, ttl }) {
              let box = named(name);
              if (box && box.group !== group) throw otherGroup(name, group);
              const awake = state.boxes.filter((b) => b.awake).length;
              if (!box?.awake && state.instanceLimit !== undefined && awake >= state.instanceLimit)
                throw instanceLimitReached();
              if (!box) state.boxes.push((box = { id: `box-${++state.seq}`, name, group, awake: false }));
              box.awake = true;
              return { id: box.id, ...link(box.id, RUNNER_PORT, ttl), protocol: RUNNER_PROTOCOL };
            },
            async expose({ name, port, ttl }) {
              const box = named(name);
              if (!box) throw noBox(name);
              return link(box.id, port, ttl);
            },
            async sleep({ name }) {
              const box = named(name);
              if (box) box.awake = false;
              return { ids: box ? [box.id] : [] };
            },
            async discard({ name, group }) {
              const leaving = state.boxes.filter((box) =>
                name === undefined ? box.group === group : box.name === name,
              );
              state.boxes = state.boxes.filter((box) => !leaving.includes(box));
              return { ids: leaving.map(({ id }) => id) };
            },
            list: async ({ group }) => ({
              boxes: state.boxes
                .filter((box) => box.group === group)
                .map(({ id, name, awake }) => ({ id, name, awake })),
            }),
          },
        };
      },
    },
    options,
  );
  const put = (type: string, _id: string, fields: Record<string, unknown>) => {
    onlyWorkspace(type);
    fake.state.instanceLimit = Workspace.parse(fields).instanceLimit;
  };
  return Object.assign(fake, {
    put,
    override: put,
    remove(type: string) {
      onlyWorkspace(type);
      fake.state.instanceLimit = undefined;
    },
  });
}
