import type { CtyType } from "./types.ts";

/**
 * How each cty type becomes zod, as source text for `resources.gen.ts`. Values inside an object
 * type may be null in the provider's state, so its attributes are nullish.
 *
 * | cty                            | zod                                  |
 * | ------------------------------ | ------------------------------------ |
 * | `string`                       | `z.string()`                         |
 * | `number`                       | `z.number()`                         |
 * | `bool`                         | `z.boolean()`                        |
 * | `["list", T]`, `["set", T]`    | `z.array(T)` (a set has no order)    |
 * | `["map", T]`                   | `z.record(z.string(), T)`            |
 * | `["object", { a: T }]`         | `z.object({ a: T.nullish() })`       |
 * | `["tuple", [T, U]]`            | `z.tuple([T, U])`                    |
 * | `dynamic`                      | `z.unknown()` (`{ value, type }` in state) |
 */
export const CTY_TO_ZOD = {
  string: () => "z.string()",
  number: () => "z.number()",
  bool: () => "z.boolean()",
  dynamic: () => "z.unknown()",
  list: (element: string) => `z.array(${element})`,
  set: (element: string) => `z.array(${element})`,
  map: (element: string) => `z.record(z.string(), ${element})`,
  object: (attributes: [name: string, zod: string][]) =>
    `z.object({ ${attributes.map(([name, zod]) => `${key(name)}: ${zod}.nullish()`).join(", ")} })`,
  tuple: (elements: string[]) => `z.tuple([${elements.join(", ")}])`,
} as const;

/** The zod source for a cty type. Throws on a type the schema document format does not have. */
export function ctyToZod(type: CtyType): string {
  if (typeof type === "string") {
    if (!Object.hasOwn(CTY_TO_ZOD, type)) throw new Error(`Unknown cty type ${JSON.stringify(type)}`);
    return CTY_TO_ZOD[type as "string" | "number" | "bool" | "dynamic"]();
  }
  const [kind, inner] = type;
  switch (kind) {
    case "list":
    case "set":
    case "map":
      return CTY_TO_ZOD[kind](ctyToZod(inner as CtyType));
    case "object":
      return CTY_TO_ZOD.object(
        Object.entries(inner as Record<string, CtyType>).map(([name, t]) => [name, ctyToZod(t)]),
      );
    case "tuple":
      return CTY_TO_ZOD.tuple((inner as CtyType[]).map(ctyToZod));
    default:
      throw new Error(`Unknown cty type ${JSON.stringify(type)}`);
  }
}

/** An object key as source: bare when it is an identifier, quoted otherwise. */
export const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));
