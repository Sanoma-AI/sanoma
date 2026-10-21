import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { EntityType, RecordType, SchemaJson, Type, TypeOfAttribute } from "@cedar-policy/cedar-wasm/nodejs";
import type { ConfigDescription } from "./describe.ts";
import type { Effect } from "./op.ts";
import { isObject } from "./resource.ts";
import { DATA_VENDOR } from "./shared.ts";

// The Cedar schema a company's policies are validated and decided against, `.sanoma/schema.cedarschema`:
// generated from `describeConfig` and the declared people, never written by hand.

const require = createRequire(import.meta.url);
let wasm: typeof import("@cedar-policy/cedar-wasm/nodejs") | undefined;

/** `@cedar-policy/cedar-wasm`'s Node build, loaded (synchronously, once) on first use, so a process that never decides with Cedar never loads it. */
export const cedarWasm = () => (wasm ??= require("@cedar-policy/cedar-wasm/nodejs") as typeof wasm)!;

/** Where `writeSchema` writes the schema's text, under a company's root. */
export const SCHEMA_FILE = join(".sanoma", "schema.cedarschema");

/** The schema's namespace: policies name `Sanoma::Group::"finance"`, `Sanoma::Action::"effect:money"`. */
export const NAMESPACE = "Sanoma";

/** Every effect, each an action group (`effect:<effect>`) its operations are in. */
export const EFFECTS: readonly Effect[] = ["read", "write", "publish", "send", "money", "access"];

/** The action group of every site and collection view. */
export const VIEW = "view";

/**
 * The people and agents a policy decides over, and the groups they are in: `resources/people.ts`,
 * read. Membership is the groups' (`members`); an agent is a member of `agents`.
 */
export interface PolicyPeople {
  people: readonly { id: string; onBehalfOf?: string }[];
  groups: readonly { name: string; members: readonly string[] }[];
}

/** The built-in group every agent is in: a rule about agents is `principal in Sanoma::Group::"agents"`. */
export const AGENTS = "agents";

export const NO_PEOPLE: PolicyPeople = { people: [], groups: [] };

/** The schema: Cedar's text (what `writeSchema` writes), the same as JSON (what `cedarPolicy` takes), and what could not be typed (each a warning). */
export interface GeneratedSchema {
  text: string;
  json: SchemaJson<string>;
  /** One line each, `<action>: <path> …`: a field left out of the schema, or typed `String` where it is a decimal number. */
  problems: string[];
}

/** What `generateSchema` reads of a description. */
export type SchemaSource = Pick<ConfigDescription, "ops" | "workflows" | "collections" | "sites" | "resourceTypes">;

const STRING = { type: "EntityOrCommon", name: "String" } as const;
const LONG = { type: "EntityOrCommon", name: "Long" } as const;
const BOOL = { type: "EntityOrCommon", name: "Bool" } as const;
const entity = (name: string) => ({ type: "Entity", name }) as const;
const record = (attributes: Record<string, TypeOfAttribute<string>>): RecordType<string> & { type: "Record" } => ({
  type: "Record",
  attributes,
});
const optional = (type: Type<string>): TypeOfAttribute<string> => ({ ...type, required: false });

/** The groups a policy may name: the declared ones, with `agents`; none when none is declared, and then any name is a group. */
export const groupNamesOf = (people: PolicyPeople): string[] =>
  people.groups.length ? [...new Set([...people.groups.map((g) => g.name), AGENTS])] : [];

/**
 * The Cedar schema for a description and the people: namespace `Sanoma`, with
 *
 * - entity types `Principal` (in `Group`, with `onBehalfOf?`), `Group`, `Collection`, `Site`,
 *   `Workflow` (each an enumeration of the declared names, `agents` among the groups, when there
 *   is one) and `Target` (in `Collection`);
 * - an action per operation id, in its effect's group (`effect:money`), on a `Target`, with
 *   `context` `{ input, before? (a collection's save and delete), run, approverGroups,
 *   approvedBy, mount }`, `input` typed from the operation's input schema;
 * - `workflow:<name>` (a start, on a `Workflow`, with the workflow's `input`), and `site:<name>`
 *   and `collection:<name>` (views, in `view`), each with `mount`.
 *
 * JSON Schema to Cedar: string and enum `String`, integer `Long`, boolean `Bool`, object a record
 * (its optional fields optional), array a `Set`. A decimal number is a `String`, and a field
 * with no Cedar type (a union of types, a map, a recursive type) is left out: each a line in
 * `problems`. Pure: the same description and people give the same schema.
 */
export function generateSchema(description: SchemaSource, people: PolicyPeople): GeneratedSchema {
  const problems: string[] = [];
  const types = new Map(description.resourceTypes.map((t) => [t.schema.$id as string, t.schema]));
  const typed = (action: string, schema: Record<string, unknown>, path = "input") =>
    cedarType(schema, { root: schema, types, seen: new Set(), warn: (p) => problems.push(`${action}: ${p}`) }, path);

  const entityTypes: SchemaJson<string>[string]["entityTypes"] = {
    Principal: { memberOfTypes: ["Group"], shape: record({ onBehalfOf: optional(entity("Principal")) }) },
    Group: enumeration(groupNamesOf(people)),
    Collection: enumeration(description.collections.map((c) => c.name)),
    Target: { memberOfTypes: ["Collection"] },
    Site: enumeration(description.sites.map((s) => s.name)),
    Workflow: enumeration(description.workflows.map((w) => w.name)),
  };

  const applies = (resource: string, context: Record<string, TypeOfAttribute<string>>) => ({
    principalTypes: ["Principal"],
    resourceTypes: [resource],
    context: record(context),
  });
  const actions: SchemaJson<string>[string]["actions"] = { [VIEW]: {} };
  for (const effect of EFFECTS) actions[`effect:${effect}`] = {};
  const befores = new Map(
    description.collections.map((c) => [c.name, typed(`collection:${c.name}`, c.record, "before")] as const),
  );
  for (const op of description.ops) {
    const input = typed(op.id, op.input);
    const before = op.vendor === DATA_VENDOR && WRITES.has(op.name) ? befores.get(op.resource) : undefined;
    actions[op.id] = {
      memberOf: [{ id: `effect:${op.effect}` }],
      appliesTo: applies("Target", {
        ...(input && { input }),
        ...(before && { before: optional(before) }),
        run: record({ id: STRING, workflow: STRING }),
        approverGroups: { type: "Set", element: entity("Group") },
        approvedBy: { type: "Set", element: entity("Principal") },
        mount: STRING,
      }),
    };
  }
  for (const wf of description.workflows) {
    const input = typed(`workflow:${wf.name}`, wf.input);
    actions[`workflow:${wf.name}`] = { appliesTo: applies("Workflow", { ...(input && { input }), mount: STRING }) };
  }
  for (const [prefix, resource, names] of [
    ["site", "Site", description.sites.map((s) => s.name)],
    ["collection", "Collection", description.collections.map((c) => c.name)],
  ] as const) {
    for (const name of names) {
      actions[`${prefix}:${name}`] = { memberOf: [{ id: VIEW }], appliesTo: applies(resource, { mount: STRING }) };
    }
  }

  const json: SchemaJson<string> = { [NAMESPACE]: { entityTypes, actions } };
  const answer = cedarWasm().schemaToText(json);
  if (answer.type === "failure") {
    throw new Error(`The generated Cedar schema does not parse: ${answer.errors.map((e) => e.message).join("; ")}`);
  }
  return { text: answer.text, json, problems: [...new Set(problems)] };
}

/** An entity type enumerating `names`, so a policy naming another fails validation; any id when there are none. */
const enumeration = (names: readonly string[]): EntityType<string> =>
  names.length ? { enum: [...names].toSorted() } : {};

/** A collection's operations that change a record, whose context has the record as it was (`before`). */
const WRITES = new Set(["save", "delete"]);

interface Typing {
  root: Record<string, unknown>;
  /** The resource types' state schemas, by `$id`, which an operation's schema `$ref`s. */
  types: ReadonlyMap<string, Record<string, unknown>>;
  /** The schemas being typed, to leave a recursive one out. */
  seen: Set<unknown>;
  warn: (problem: string) => void;
}

/** The Cedar type of a JSON Schema (`describeConfig`'s, draft 2020-12), or undefined when it has none, with a warning naming `path`. */
function cedarType(schema: unknown, typing: Typing, path: string): Type<string> | undefined {
  const none = (why: string) => {
    typing.warn(`${path} is left out: ${why}`);
    return undefined;
  };
  if (!isObject(schema)) return none("it has no schema");
  if (typing.seen.has(schema)) return none("its type refers to itself");
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    const target = ref.startsWith("#/$defs/")
      ? (typing.root.$defs as Record<string, unknown> | undefined)?.[ref.slice("#/$defs/".length)]
      : typing.types.get(ref);
    return within(schema, typing, () => cedarType(target, typing, path));
  }
  const variants = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined;
  if (Array.isArray(variants)) {
    const some = variants.filter((v) => !isNull(v));
    const each = within(schema, typing, () => some.map((v) => cedarType(v, { ...typing, warn: () => {} }, path)));
    const first = each[0];
    if (first && each.every((t) => t && JSON.stringify(t) === JSON.stringify(first))) return first;
    return none("its value is one of several types");
  }
  const values = Array.isArray(schema.enum) ? schema.enum : "const" in schema ? [schema.const] : undefined;
  if (values) {
    if (values.every((v) => typeof v === "string")) return STRING;
    if (values.every((v) => Number.isSafeInteger(v))) return LONG;
    if (values.every((v) => typeof v === "boolean")) return BOOL;
    return none("its values are of several types");
  }
  const type = Array.isArray(schema.type) ? schema.type.filter((t) => t !== "null") : [schema.type];
  if (type.length !== 1) return none(type.length ? "its value is one of several types" : "it has no type");
  switch (type[0]) {
    case "string":
      return STRING;
    case "integer":
      return LONG;
    case "boolean":
      return BOOL;
    case "number":
      typing.warn(`${path} is a decimal number, a String in the schema: z.number().int() makes it a Long`);
      return STRING;
    case "array": {
      if (!isObject(schema.items)) return none("an array of more than one type");
      const element = within(schema, typing, () => cedarType(schema.items, typing, `${path}[]`));
      return element && { type: "Set", element };
    }
    case "object": {
      if (!isObject(schema.properties) || !Object.keys(schema.properties).length) {
        return schema.additionalProperties === false || schema.additionalProperties === undefined
          ? record({})
          : none("a map, whose keys are not known");
      }
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const attributes: Record<string, TypeOfAttribute<string>> = {};
      for (const [name, property] of Object.entries(schema.properties)) {
        const typed = within(schema, typing, () => cedarType(property, typing, `${path}.${name}`));
        if (!typed) continue;
        attributes[name] = required.has(name) && !allowsNull(property) ? typed : optional(typed);
      }
      return record(attributes);
    }
    default:
      return none(`no Cedar type for ${JSON.stringify(type[0])}`);
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

/**
 * Writes `<root>/.sanoma/schema.cedarschema` (`generateSchema`'s text) when it differs from the
 * file's, so an editor sees no change when there is none; `wrote` says whether it did.
 */
export async function writeSchema(
  root: string,
  description: SchemaSource,
  people: PolicyPeople,
): Promise<{ wrote: boolean; file: string; problems: string[] }> {
  const file = join(root, SCHEMA_FILE);
  const { text, problems } = generateSchema(description, people);
  if ((await readFile(file, "utf8").catch(() => undefined)) === text) return { wrote: false, file, problems };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return { wrote: true, file, problems };
}
