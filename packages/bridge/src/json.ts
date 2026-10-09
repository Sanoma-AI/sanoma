import type { Block, NestedType } from "./schema.ts";

/** A JSON object, as a provider's state or a fixture holds it. */
export type JsonObject = Record<string, unknown>;

/** True for a plain object: not `null`, not an array. */
export const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** A nested attribute's children as a block, so code that walks blocks walks them too. */
export const blockOf = (nested: NestedType): Block => ({ attributes: nested.attributes, blocks: {} });
