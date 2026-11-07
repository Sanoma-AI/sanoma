import { isObject, type JsonObject as State } from "../json.ts";
import type { TfBlockShape, TfShape } from "./types.ts";

/**
 * The provider's state in the resource's shape: a block of at most one item becomes that item
 * (or `null`), and sensitive or write-only attributes become `null`, so a secret never leaves
 * the driver. Attributes the shape does not know (a newer provider's) are dropped.
 */
export function fromTfState(shape: TfShape, state: State): State {
  const out: State = {};
  for (const name of shape.attributes) out[name] = shape.secret?.includes(name) ? null : (state[name] ?? null);
  for (const [name, block] of Object.entries(shape.blocks ?? {})) out[name] = blockFrom(block, state[name]);
  return out;
}

function blockFrom(block: TfBlockShape, value: unknown): unknown {
  const item = (v: unknown) => (isObject(v) ? fromTfState(block.shape, v) : null);
  if (block.nesting === "single" || block.nesting === "group") return item(value);
  if (block.nesting === "map") {
    return isObject(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, item(v)])) : null;
  }
  const items = Array.isArray(value) ? value : [];
  return block.one ? item(items[0]) : items.map(item);
}

/**
 * State in the resource's shape back in the provider's: every attribute present (`null` when
 * unset), a block of one item a list again, and absent list and set blocks empty. The inverse of
 * `fromTfState`, except for the secrets it dropped, which go back as `null`.
 */
export function toTfState(shape: TfShape, state: State): State {
  const out: State = {};
  for (const name of shape.attributes) out[name] = state[name] ?? null;
  for (const [name, block] of Object.entries(shape.blocks ?? {})) out[name] = blockTo(block, state[name]);
  return out;
}

function blockTo(block: TfBlockShape, value: unknown): unknown {
  const item = (v: State) => toTfState(block.shape, v);
  if (block.nesting === "single" || block.nesting === "group") return isObject(value) ? item(value) : null;
  if (block.nesting === "map") {
    return isObject(value)
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isObject(v) ? item(v) : null]))
      : null;
  }
  if (block.one) return isObject(value) ? [item(value)] : [];
  return Array.isArray(value) ? value.filter(isObject).map(item) : [];
}
