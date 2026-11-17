// A JSON Schema as the reference pages read one (scripts/reference.ts writes them with zod's
// `toJSONSchema`, every schema inline): the keywords zod emits for the connectors, and how a page
// says each.

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  deprecated?: boolean;
  contentEncoding?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

/** A schema's type in a few words: `string`, `string[]`, `"a" | "b"`, `object`, `string | null`. */
export function typeOf(schema: JsonSchema): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.anyOf) return [...new Set(schema.anyOf.map(typeOf))].join(" | ");
  const type = Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type;
  if (type === "array") {
    const item = schema.items ? typeOf(schema.items) : "any";
    return item.includes(" ") ? `(${item})[]` : `${item}[]`;
  }
  if (type === "object" && !schema.properties && typeof schema.additionalProperties === "object") {
    return `record of ${typeOf(schema.additionalProperties)}`;
  }
  return type ?? "any";
}

const isNull = (schema: JsonSchema) => schema.type === "null";

/**
 * A field as a page lists it: a value that may also be null (`anyOf` of one schema and null) is
 * that schema, which holds its description and limits; its type still says `| null` (`typeOf`).
 */
export function fieldOf(schema: JsonSchema): JsonSchema {
  const options = schema.anyOf?.filter((option) => !isNull(option));
  if (!options || options.length !== 1 || options.length === schema.anyOf?.length) return schema;
  return { ...options[0], description: schema.description ?? options[0]!.description };
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** zod writes an integer's range as the safe integers': no limit a reader has to keep. */
const isLimit = (n: number | undefined): n is number => n !== undefined && Math.abs(n) !== Number.MAX_SAFE_INTEGER;

/** The limits a value has to keep, each in words; an array's items' and a record's values' among them. */
export function factsOf(given: JsonSchema): string[] {
  const schema = fieldOf(given);
  const facts: string[] = [];
  if (schema.format) facts.push(`format ${schema.format}`);
  if (schema.contentEncoding) facts.push(`encoded as ${schema.contentEncoding}`);
  if (schema.pattern) facts.push(`matches ${schema.pattern}`);
  if (schema.minLength !== undefined) facts.push(`at least ${count(schema.minLength, "character")}`);
  if (schema.maxLength !== undefined) facts.push(`at most ${count(schema.maxLength, "character")}`);
  if (isLimit(schema.minimum)) facts.push(`at least ${schema.minimum}`);
  if (isLimit(schema.exclusiveMinimum)) facts.push(`more than ${schema.exclusiveMinimum}`);
  if (isLimit(schema.maximum)) facts.push(`at most ${schema.maximum}`);
  if (isLimit(schema.exclusiveMaximum)) facts.push(`less than ${schema.exclusiveMaximum}`);
  if (schema.multipleOf !== undefined) facts.push(`a multiple of ${schema.multipleOf}`);
  if (schema.minItems !== undefined) facts.push(`at least ${count(schema.minItems, "item")}`);
  if (schema.maxItems !== undefined) facts.push(`at most ${count(schema.maxItems, "item")}`);
  if (schema.default !== undefined) facts.push(`default ${JSON.stringify(schema.default)}`);
  if (schema.items) facts.push(...factsOf(schema.items).map((fact) => `each item: ${fact}`));
  if (typeof schema.additionalProperties === "object") {
    facts.push(...factsOf(schema.additionalProperties).map((fact) => `each value: ${fact}`));
  }
  return facts;
}

/** Whether `schema` is an object with fields of its own to list. */
export const hasFields = (schema: JsonSchema) => Object.keys(schema.properties ?? {}).length > 0;

/**
 * The schemas with fields of their own that `schema` holds, each under what it is: the object
 * itself, an array's items, a record's values, or each object among a union's alternatives.
 */
export function nestedOf(schema: JsonSchema): { label: string; schema: JsonSchema }[] {
  if (hasFields(schema)) return [{ label: "Fields", schema }];
  if (schema.items) return nestedOf(schema.items).map(({ schema: inner }) => ({ label: "Each item", schema: inner }));
  if (typeof schema.additionalProperties === "object") {
    return nestedOf(schema.additionalProperties).map(({ schema: inner }) => ({ label: "Each value", schema: inner }));
  }
  // An alternative keeps what it is ("Each item" of a list that may be null), numbered when there are several.
  const objects = (schema.anyOf ?? []).flatMap(nestedOf);
  return objects.map(({ label, schema: inner }, i) => ({
    label: objects.length > 1 ? `${label}, alternative ${i + 1}` : label,
    schema: inner,
  }));
}

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** A description as HTML: escaped, with `code` in backticks as code. */
export const descriptionHtml = (text: string) => escape(text).replaceAll(/`([^`]+)`/g, "<code>$1</code>");
