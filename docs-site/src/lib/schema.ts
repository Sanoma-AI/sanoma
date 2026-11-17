// A JSON Schema as the reference pages read one (scripts/reference.ts writes them with zod's
// `toJSONSchema`): the few keywords zod emits, and how a page says each.

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  prefixItems?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
}

/** `schema`, or what its `$ref` names among `root`'s `$defs`. */
export function resolve(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const name = schema.$ref?.match(/^#\/\$defs\/(.+)$/)?.[1];
  return (name !== undefined && root.$defs?.[name]) || schema;
}

const alternatives = (schema: JsonSchema) => schema.anyOf ?? schema.oneOf;

/** A schema's type in a few words: `string`, `string[]`, `"a" | "b"`, `object`, `string | null`. */
export function typeOf(given: JsonSchema, root: JsonSchema): string {
  const schema = resolve(given, root);
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  const options = alternatives(schema);
  if (options) return [...new Set(options.map((option) => typeOf(option, root)))].join(" | ");
  if (schema.allOf) return schema.allOf.map((part) => typeOf(part, root)).join(" & ");
  const type = Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type;
  if (type === "array") {
    if (schema.prefixItems) return `[${schema.prefixItems.map((item) => typeOf(item, root)).join(", ")}]`;
    const item = schema.items ? typeOf(schema.items, root) : "any";
    return /[ |&]/.test(item) ? `(${item})[]` : `${item}[]`;
  }
  if (type === "object" && !schema.properties && typeof schema.additionalProperties === "object") {
    return `record of ${typeOf(schema.additionalProperties, root)}`;
  }
  return type ?? "any";
}

/** The limits a value has to keep, each in words. */
export function factsOf(given: JsonSchema, root: JsonSchema): string[] {
  const schema = resolve(given, root);
  const facts: string[] = [];
  if (schema.format) facts.push(`format ${schema.format}`);
  if (schema.pattern) facts.push(`matches ${schema.pattern}`);
  if (schema.minLength !== undefined) facts.push(`at least ${count(schema.minLength, "character")}`);
  if (schema.maxLength !== undefined) facts.push(`at most ${count(schema.maxLength, "character")}`);
  if (schema.minimum !== undefined) facts.push(`at least ${schema.minimum}`);
  if (schema.exclusiveMinimum !== undefined) facts.push(`more than ${schema.exclusiveMinimum}`);
  if (schema.maximum !== undefined) facts.push(`at most ${schema.maximum}`);
  if (schema.exclusiveMaximum !== undefined) facts.push(`less than ${schema.exclusiveMaximum}`);
  if (schema.minItems !== undefined) facts.push(`at least ${count(schema.minItems, "item")}`);
  if (schema.maxItems !== undefined) facts.push(`at most ${count(schema.maxItems, "item")}`);
  if (schema.default !== undefined) facts.push(`default ${JSON.stringify(schema.default)}`);
  return facts;
}

/**
 * The schemas with fields of their own that `schema` holds, each under what it is: the object
 * itself, an array's items, a record's values, or each object among a union's alternatives.
 */
export function nestedOf(given: JsonSchema, root: JsonSchema, depth = 0): { label: string; schema: JsonSchema }[] {
  const schema = resolve(given, root);
  // A schema that names itself (a tree) is followed a few levels, not for ever.
  if (depth > 6) return [];
  if (schema.properties && Object.keys(schema.properties).length) return [{ label: "Fields", schema }];
  if (schema.items) {
    return nestedOf(schema.items, root, depth + 1).map(({ schema: inner }) => ({ label: "Each item", schema: inner }));
  }
  if (typeof schema.additionalProperties === "object") {
    return nestedOf(schema.additionalProperties, root, depth + 1).map(({ schema: inner }) => ({
      label: "Each value",
      schema: inner,
    }));
  }
  const options = alternatives(schema) ?? schema.allOf;
  if (options) {
    const objects = options.flatMap((option) => nestedOf(option, root, depth + 1));
    return objects.map(({ schema: inner }, i) => ({
      label: objects.length > 1 ? `Fields, alternative ${i + 1}` : "Fields",
      schema: inner,
    }));
  }
  return [];
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** A description as HTML: escaped, with `code` in backticks as code. */
export const descriptionHtml = (text: string) => escape(text).replaceAll(/`([^`]+)`/g, "<code>$1</code>");
