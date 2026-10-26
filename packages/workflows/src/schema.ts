import { createRequire } from "node:module";
import { join } from "node:path";
import type {
  DetailedError,
  EntityType,
  RecordType,
  SchemaJson,
  Type,
  TypeOfAttribute,
} from "@cedar-policy/cedar-wasm/nodejs";
import { ChangeFacts } from "./change.ts";
import { recordSchemaOf } from "./collection.ts";
import type { ResolvedConfig } from "./config.ts";
import { jsonSchemaOf } from "./define.ts";
import { isObject } from "./resource.ts";
import { CHANGE_MERGE, DATA_VENDOR, EFFECTS, groupNamesOf, type PeopleResource, WORKFLOW_ACTION } from "./shared.ts";

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

/** The action group every workflow start (`workflow:<name>`) is in. */
export const START = "start";

/** The entity type a change's merge acts on (`Sanoma::Change`), its attributes the change's facts. */
export const CHANGE = "Change";

const STRING = { type: "EntityOrCommon", name: "String" } as const;
const LONG = { type: "EntityOrCommon", name: "Long" } as const;
const BOOL = { type: "EntityOrCommon", name: "Bool" } as const;
const entity = (name: string) => ({ type: "Entity", name }) as const;
const record = (attributes: Record<string, TypeOfAttribute<string>>): RecordType<string> & { type: "Record" } => ({
  type: "Record",
  attributes,
});
const optional = (type: Type<string>): TypeOfAttribute<string> => ({ ...type, required: false });

/**
 * The Cedar type of a zod schema's parsed value (`io: "output"`: what the policy is given, defaults
 * filled and transforms applied), through its JSON Schema; undefined when it has none.
 */
const typeOf = (schema: Parameters<typeof jsonSchemaOf>[0]) => {
  const json = jsonSchemaOf(schema, "output");
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
 * - `entity Group enum [...]`, the declared groups, `agents` and `visitors`, so a policy naming another fails
 *   validation; `entity Principal in [Group] { onBehalfOf?: Principal }`; `Collection`;
 *   `Target in [Collection]`; `Workflow`;
 * - an action per operation id, in its effect's group (`effect:money`), on a `Target`, with
 *   `context` `{ input, before? }`: `input` from the operation's input schema, `before` the record
 *   as it was for a collection's `save` and `delete`; `sanoma.change.merge` on a `Change`, whose
 *   attributes are a change's facts (`ChangeFacts`), so a rule reads `resource.touches`;
 * - `workflow:<name>` per workflow, in the group `start`, on a `Workflow`, with its `input`.
 *
 * Zod to Cedar, through the JSON Schema of the parsed value: string and enum `String`, integer `Long`, boolean `Bool`,
 * object a record (its optional and nullable fields optional), array a `Set`; a decimal number
 * is a `String`; a field with no Cedar type (a union of types, a map, a recursive type) is left
 * out, so a policy naming it fails validation. Pure: the same config and people give the same schema.
 */
function buildSchema(
  resolved: Pick<ResolvedConfig, "ops" | "workflows" | "collections">,
  people: readonly PeopleResource[],
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
      appliesTo: applies(op.id === CHANGE_MERGE ? CHANGE : "Target", {
        ...input(op.input),
        ...(before && { before: optional(before) }),
      }),
    };
  }
  for (const name of [...resolved.workflows.keys()].toSorted()) {
    actions[`${WORKFLOW_ACTION}${name}`] = {
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
    [CHANGE]: { shape: typeOf(ChangeFacts) as RecordType<string> & { type: "Record" } },
  };
  return { [NAMESPACE]: { entityTypes, actions } };
}

const schemas = new WeakMap<object, WeakMap<readonly PeopleResource[], CedarSchemaJson>>();

/**
 * The Cedar schema for a resolved config and its people (`buildSchema`), made once for each pair:
 * validating, deciding and writing it share one.
 */
export function schemaOf(
  resolved: Pick<ResolvedConfig, "ops" | "workflows" | "collections">,
  people: readonly PeopleResource[],
): CedarSchemaJson {
  let byPeople = schemas.get(resolved.ops);
  if (!byPeople) schemas.set(resolved.ops, (byPeople = new WeakMap()));
  let schema = byPeople.get(people);
  if (!schema) byPeople.set(people, (schema = buildSchema(resolved, people)));
  return schema;
}

/** The schema as Cedar's text, through the package's own `schemaToText`: what `.sanoma/schema.cedarschema` holds. */
export function schemaText(schema: CedarSchemaJson): string {
  const answer = cedarWasm().schemaToText(schema);
  if (answer.type === "failure") {
    throw new Error(`The Cedar schema does not print: ${answer.errors.map(messageOf).join("; ")}`);
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

/** Cedar's message, with its help when it has one. */
export const messageOf = (e: DetailedError) => (e.help ? `${e.message} (${e.help})` : e.message);

/** An action's context type in the schema: a record, when the action is there. */
export const contextTypeOf = (schema: CedarSchemaJson, action: string) =>
  schema[NAMESPACE]?.actions[action]?.appliesTo?.context as (RecordType<string> & { type: "Record" }) | undefined;

/**
 * A value as Cedar takes it for a type `schemaOf` wrote (`cedarType`'s other side): a record's
 * fields it declares only, a set's elements, a number where it is a `String` as text. An unknown
 * (`{ __extn: unknown }`) passes as it is; what does not fit is left out (undefined), as `null` is.
 */
export function cedarValue(value: unknown, type: Type<string>): unknown {
  if (value === null || value === undefined) return undefined;
  if (isObject(value) && "__extn" in value) return value;
  const t = type as { type: string; name?: string; element?: Type<string>; attributes?: Record<string, Type<string>> };
  if (t.attributes) {
    if (!isObject(value)) return undefined;
    return Object.fromEntries(
      Object.entries(t.attributes).flatMap(([name, field]) => {
        const shaped = cedarValue(value[name], field);
        return shaped === undefined ? [] : [[name, shaped]];
      }),
    );
  }
  if (t.type === "Set") {
    return Array.isArray(value)
      ? value.map((v) => cedarValue(v, t.element!)).filter((v) => v !== undefined)
      : undefined;
  }
  switch (t.name) {
    case STRING.name:
      return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
    case LONG.name:
      return Number.isSafeInteger(value) ? value : undefined;
    case BOOL.name:
      return typeof value === "boolean" ? value : undefined;
    default:
      return undefined;
  }
}
