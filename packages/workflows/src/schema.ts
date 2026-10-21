import { createRequire } from "node:module";
import { join } from "node:path";
import type { EntityType, RecordType, SchemaJson, Type, TypeOfAttribute } from "@cedar-policy/cedar-wasm/nodejs";
import { recordSchemaOf } from "./collection.ts";
import type { ResolvedConfig } from "./config.ts";
import { jsonSchemaOf } from "./define.ts";
import type { Effect } from "./op.ts";
import { isObject } from "./resource.ts";
import { DATA_VENDOR } from "./shared.ts";

// The Cedar schema a company's policies are validated and decided against: made from the
// resolved config and the people, in memory for the evaluator, and written as text to
// `.sanoma/schema.cedarschema` for the policies' author.

const require = createRequire(import.meta.url);
let wasm: typeof import("@cedar-policy/cedar-wasm/nodejs") | undefined;

/** `@cedar-policy/cedar-wasm`'s Node build, loaded (synchronously, once) on first use, so a process that never decides with Cedar never loads it. */
export const cedarWasm = () => (wasm ??= require("@cedar-policy/cedar-wasm/nodejs") as typeof wasm)!;

/** The schema as Cedar's JSON format has it. */
export type CedarSchemaJson = SchemaJson<string>;

/** Where the schema's text is written, under a company's root. */
export const SCHEMA_FILE = join(".sanoma", "schema.cedarschema");

/** The schema's namespace: policies name `Sanoma::Group::"finance"`, `Sanoma::Action::"effect:money"`. */
export const NAMESPACE = "Sanoma";

/** Every effect, each an action group (`effect:<effect>`) its operations are in. */
const EFFECTS: readonly Effect[] = ["read", "write", "publish", "send", "money", "access"];

/** The action group every workflow start (`workflow:<name>`) is in. */
export const START = "start";

/** The built-in group every agent is in: a rule about agents is `principal in Sanoma::Group::"agents"`. */
export const AGENTS = "agents";

/**
 * The people and agents a policy decides over, and their groups: the resolved resources of the
 * built-in `sanoma.person`, `sanoma.agent` and `sanoma.group`. Membership is the groups'.
 */
export interface PolicyPeople {
  people: readonly { id: string; onBehalfOf?: string }[];
  groups: readonly { name: string; members: readonly string[] }[];
}

/** No one declared: the launcher's people until the people file is read. */
export const NO_PEOPLE: PolicyPeople = { people: [], groups: [] };

/** The groups a policy may name: the declared ones and `agents`, sorted. */
export const groupNamesOf = (people: PolicyPeople): string[] =>
  [...new Set([...people.groups.map((g) => g.name), AGENTS])].toSorted();

const STRING = { type: "EntityOrCommon", name: "String" } as const;
const LONG = { type: "EntityOrCommon", name: "Long" } as const;
const BOOL = { type: "EntityOrCommon", name: "Bool" } as const;
const entity = (name: string) => ({ type: "Entity", name }) as const;
const record = (attributes: Record<string, TypeOfAttribute<string>>): RecordType<string> & { type: "Record" } => ({
  type: "Record",
  attributes,
});
const optional = (type: Type<string>): TypeOfAttribute<string> => ({ ...type, required: false });

/** The Cedar type of a zod schema, through its JSON Schema; undefined when it has none. */
const typeOf = (schema: Parameters<typeof jsonSchemaOf>[0]) => {
  const json = jsonSchemaOf(schema, "input");
  return cedarType(json, { root: json, seen: new Set() });
};

/** A context's `input`, typed from a zod schema: none when it has no Cedar type. */
const input = (schema: Parameters<typeof jsonSchemaOf>[0]): Record<string, TypeOfAttribute<string>> => {
  const type = typeOf(schema);
  return type ? { input: type } : {};
};

/** A collection's operations that change a record, whose context has the record as it was (`before`). */
const WRITES = new Set(["save", "delete"]);

/**
 * The Cedar schema for a resolved config and its people, namespace `Sanoma`:
 *
 * - `entity Group enum [...]`, the declared groups and `agents`, so a policy naming another fails
 *   validation; `entity Principal in [Group] { onBehalfOf?: Principal }`; `Collection`;
 *   `Target in [Collection]`; `Workflow`;
 * - an action per operation id, in its effect's group (`effect:money`), on a `Target`, with
 *   `context` `{ input, before? }`: `input` from the operation's input schema, `before` the record
 *   as it was for a collection's `save` and `delete`;
 * - `workflow:<name>` per workflow, in the group `start`, on a `Workflow`, with its `input`.
 *
 * Zod to Cedar, through JSON Schema: string and enum `String`, integer `Long`, boolean `Bool`,
 * object a record (its optional and nullable fields optional), array a `Set`; a decimal number
 * is a `String`; a field with no Cedar type (a union of types, a map, a recursive type) is left
 * out, so a policy naming it fails validation. Pure: the same config and people give the same schema.
 */
export function schemaOf(
  resolved: Pick<ResolvedConfig, "ops" | "workflows" | "collections">,
  people: PolicyPeople,
): CedarSchemaJson {
  const applies = (resource: string, context: Record<string, TypeOfAttribute<string>>) => ({
    principalTypes: ["Principal"],
    resourceTypes: [resource],
    context: record(context),
  });
  const actions: CedarSchemaJson[string]["actions"] = { [START]: {} };
  for (const effect of EFFECTS) actions[`effect:${effect}`] = {};
  for (const op of [...resolved.ops.values()].toSorted((a, b) => a.id.localeCompare(b.id))) {
    const collection =
      op.vendor === DATA_VENDOR && WRITES.has(op.name) ? resolved.collections.get(op.resource) : undefined;
    const before = collection && typeOf(recordSchemaOf(collection));
    actions[op.id] = {
      memberOf: [{ id: `effect:${op.effect}` }],
      appliesTo: applies("Target", { ...input(op.input), ...(before && { before: optional(before) }) }),
    };
  }
  for (const name of [...resolved.workflows.keys()].toSorted()) {
    actions[`workflow:${name}`] = {
      memberOf: [{ id: START }],
      appliesTo: applies("Workflow", input(resolved.workflows.get(name)!.input)),
    };
  }
  const entityTypes: Record<string, EntityType<string>> = {
    Group: { enum: groupNamesOf(people) },
    Principal: { memberOfTypes: ["Group"], shape: record({ onBehalfOf: optional(entity("Principal")) }) },
    Collection: {},
    Target: { memberOfTypes: ["Collection"] },
    Workflow: {},
  };
  return { [NAMESPACE]: { entityTypes, actions } };
}

/** The schema as Cedar's text, through the package's own `schemaToText`: what `.sanoma/schema.cedarschema` holds. */
export function schemaText(schema: CedarSchemaJson): string {
  const answer = cedarWasm().schemaToText(schema);
  if (answer.type === "failure") {
    throw new Error(`The Cedar schema does not print: ${answer.errors.map((e) => e.message).join("; ")}`);
  }
  return answer.text;
}

interface Typing {
  root: Record<string, unknown>;
  /** The schemas being typed, to leave a recursive one out. */
  seen: Set<unknown>;
}

/** The Cedar type of a JSON Schema (`jsonSchemaOf`'s, draft 2020-12), or undefined when it has none. */
function cedarType(schema: unknown, typing: Typing): Type<string> | undefined {
  if (!isObject(schema) || typing.seen.has(schema)) return undefined;
  if (typeof schema.$ref === "string") {
    const defs = typing.root.$defs as Record<string, unknown> | undefined;
    const target = schema.$ref.startsWith("#/$defs/") ? defs?.[schema.$ref.slice("#/$defs/".length)] : undefined;
    return within(schema, typing, () => cedarType(target, typing));
  }
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) {
    const each = within(schema, typing, () => variants.filter((v) => !isNull(v)).map((v) => cedarType(v, typing)));
    const first = each[0];
    return first && each.every((t) => t && JSON.stringify(t) === JSON.stringify(first)) ? first : undefined;
  }
  const values = Array.isArray(schema.enum) ? schema.enum : "const" in schema ? [schema.const] : undefined;
  if (values) {
    if (values.every((v) => typeof v === "string")) return STRING;
    if (values.every((v) => Number.isSafeInteger(v))) return LONG;
    return values.every((v) => typeof v === "boolean") ? BOOL : undefined;
  }
  const types = Array.isArray(schema.type) ? schema.type.filter((t) => t !== "null") : [schema.type];
  if (types.length !== 1) return undefined;
  switch (types[0]) {
    case "string":
    case "number":
      // Cedar has no decimal number: one is compared as text.
      return STRING;
    case "integer":
      return LONG;
    case "boolean":
      return BOOL;
    case "array": {
      const element = within(schema, typing, () => cedarType(schema.items, typing));
      return element && { type: "Set", element };
    }
    case "object": {
      // A map's keys are not known: it has no Cedar type.
      if (!isObject(schema.properties)) return schema.additionalProperties ? undefined : record({});
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const attributes: Record<string, TypeOfAttribute<string>> = {};
      for (const [name, property] of Object.entries(schema.properties)) {
        const type = within(schema, typing, () => cedarType(property, typing));
        if (type) attributes[name] = required.has(name) && !allowsNull(property) ? type : optional(type);
      }
      return record(attributes);
    }
    default:
      return undefined;
  }
}

/** `type()` with `schema` marked as being typed, so a reference back to it is not followed. */
function within<T>(schema: unknown, typing: Typing, type: () => T): T {
  typing.seen.add(schema);
  try {
    return type();
  } finally {
    typing.seen.delete(schema);
  }
}

const isNull = (schema: unknown) => isObject(schema) && schema.type === "null";

/** True when a JSON Schema accepts `null`: its value is then optional in Cedar, which has no null. */
const allowsNull = (schema: unknown): boolean =>
  isObject(schema) &&
  (isNull(schema) ||
    (Array.isArray(schema.type) && schema.type.includes("null")) ||
    [schema.anyOf, schema.oneOf].some((v) => Array.isArray(v) && v.some(isNull)));
