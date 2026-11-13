import { randomBytes } from "node:crypto";
import { RUNNER_PORT, RUNNER_PROTOCOL } from "sanoma/workflows";
import { defineFake, type FakeOptions } from "sanoma/workflows/fake";
import { agent37Ops } from "./connector.ts";
import { EDGE } from "./backend.ts";
import { instanceOperations, noBox } from "./operations.ts";

interface FakeBox {
  id: string;
  name: string;
  group: string;
  awake: boolean;
}

/** A link to the box `id`'s `port` for `ttl` seconds, as Agent37 mints one. */
const link = (id: string, port: number, ttl: number) => ({
  url: `${EDGE(id, port)}/?a37_token=${randomBytes(16).toString("hex")}`,
  expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
});

/**
 * An Agent37 whose key works: it holds no instances for the instance type's operations, and its
 * boxes in memory, made by `box.open`.
 */
export function fakeAgent37(options: FakeOptions = {}) {
  return defineFake(
    agent37Ops,
    {
      initial: () => ({ boxes: [] as FakeBox[] }),
      ops: (state) => {
        const named = (name: string) => state.boxes.find((box) => box.name === name);
        return {
          ...instanceOperations(async () => []),
          box: {
            async open({ name, group, ttl }) {
              let box = named(name);
              if (!box) state.boxes.push((box = { id: randomBytes(5).toString("hex"), name, group, awake: false }));
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
}
