import type { CtyType } from "../schema.ts";

/**
 * The zod source for a cty type, for `resources.gen.ts`. Values inside an object type may be
 * null in the provider's state, so its attributes are nullish. Throws on a type the schema
 * document format does not have.
 *
 * | cty                            | zod                                         |
 * | ------------------------------ | ------------------------------------------- |
 * | `string`                       | `z.string()`                                |
 * | `number`                       | `z.number()`                                |
 * | `bool`                         | `z.boolean()`                               |
 * | `["list", T]`, `["set", T]`    | `z.array(T)` (a set's order is not compared) |
 * | `["map", T]`                   | `z.record(z.string(), T)`                   |
 * | `["object", { a: T }]`         | `z.object({ a: T.nullish() })`              |
 * | `["tuple", [T, U]]`            | `z.tuple([T, U])`                           |
 * | `dynamic`                      | `z.unknown()` (`{ value, type }` in state)  |
 */
export function ctyToZod(type: CtyType): string {
  if (typeof type === "string") {
    switch (type) {
      case "string":
        return "z.string()";
      case "number":
        return "z.number()";
      case "bool":
        return "z.boolean()";
      case "dynamic":
        return "z.unknown()";
    }
  } else {
    switch (type[0]) {
      case "list":
      case "set":
        return `z.array(${ctyToZod(type[1])})`;
      case "map":
        return `z.record(z.string(), ${ctyToZod(type[1])})`;
      case "object": {
        const attributes = Object.entries(type[1]).map(([name, t]) => `${key(name)}: ${ctyToZod(t)}.nullish()`);
        return `z.object({ ${attributes.join(", ")} })`;
      }
      case "tuple":
        return `z.tuple([${type[1].map(ctyToZod).join(", ")}])`;
    }
  }
  throw new Error(`Unknown cty type ${JSON.stringify(type)}`);
}

/** An object key as source: bare when it is an identifier, quoted otherwise. */
export const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));
