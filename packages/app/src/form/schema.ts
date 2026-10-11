/**
 * Fields for a start form, read from a workflow's input JSON Schema (`describeConfig`'s
 * `workflows[].input`). Strings, date-times, numbers, booleans and enums get their own control;
 * arrays and objects get one level of nesting (an array of objects, or an object, of those
 * kinds); anything else is entered as JSON. The server validates the input with the workflow's
 * zod schema, so this only shapes the form and never decides what is valid.
 */

export type Scalar = "string" | "datetime" | "number" | "integer" | "boolean" | "enum" | "json";

interface Base {
  /** The property's name in its object. */
  key: string;
  label: string;
  required: boolean;
  description?: string;
  default?: unknown;
}

export interface ScalarField extends Base {
  kind: Scalar;
  /** For an enum: the allowed values. */
  options?: unknown[];
}

export interface ObjectField extends Base {
  kind: "object";
  fields: ScalarField[];
}

export interface ArrayField extends Base {
  kind: "array";
  item: ScalarField | ObjectField;
}

export type Field = ScalarField | ObjectField | ArrayField;

/**
 * What the form holds for a scalar: text for most (an enum holds its option's index, a date-time
 * its ISO text, which `DateTimeInput` shows in the browser's time zone), a checkbox state for booleans.
 */
export type ScalarValue = string | boolean | undefined;
export type Value = ScalarValue | Record<string, ScalarValue> | Value[];
export type Values = Record<string, Value>;

type Schema = Record<string, unknown>;

const isRecord = (x: unknown): x is Schema => typeof x === "object" && x !== null && !Array.isArray(x);

/** The top-level fields, or undefined when the input is not an object with properties. */
export function fieldsOf(schema: Schema): Field[] | undefined {
  if (schema.type !== "object" || !isRecord(schema.properties)) return undefined;
  return propertiesOf(schema, 0);
}

function propertiesOf(schema: Schema, depth: number): Field[] {
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(schema.properties as Schema).map(([key, raw]) =>
    fieldOf(key, isRecord(raw) ? raw : {}, required.has(key), depth),
  );
}

function fieldOf(key: string, prop: Schema, required: boolean, depth: number): Field {
  const base: Base = {
    key,
    label: typeof prop.title === "string" ? prop.title : key,
    required,
    ...(typeof prop.description === "string" ? { description: prop.description } : {}),
    ...("default" in prop ? { default: prop.default } : {}),
  };
  if (depth === 0 && prop.type === "array" && isRecord(prop.items)) {
    const item = fieldOf("item", prop.items, true, 1);
    if (item.kind !== "array" && item.kind !== "json") return { ...base, kind: "array", item };
  }
  if (depth <= 1 && prop.type === "object" && isRecord(prop.properties) && !hasExtraKeys(prop)) {
    const fields = propertiesOf(prop, 2);
    if (fields.every((f): f is ScalarField => f.kind !== "object" && f.kind !== "array")) {
      return { ...base, kind: "object", fields };
    }
  }
  const kind = scalarKind(prop);
  return kind === "enum" ? { ...base, kind, options: prop.enum as unknown[] } : { ...base, kind };
}

/** An object that also takes other keys can't be shown as just its properties. */
const hasExtraKeys = (prop: Schema) => prop.additionalProperties !== undefined && prop.additionalProperties !== false;

function scalarKind(prop: Schema): Scalar {
  if (Array.isArray(prop.enum) && prop.enum.length && prop.enum.every((v) => v === null || typeof v !== "object")) {
    return "enum";
  }
  switch (prop.type) {
    case "string":
      return prop.format === "date-time" ? "datetime" : "string";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    default:
      return "json";
  }
}

/** The form's starting values: each field's value in `input` (a scenario's), else its default, else empty. */
export function initialValues(fields: Field[], input?: unknown): Values {
  return Object.fromEntries(
    fields.map((f) => [f.key, initialValue(f, isRecord(input) && f.key in input ? input[f.key] : f.default)]),
  );
}

/** A field's starting value from `d`. */
export function initialValue(field: Field, d: unknown): Value {
  switch (field.kind) {
    case "array":
      return Array.isArray(d) ? d.map((v) => initialValue(field.item, v)) : [];
    case "object":
      return Object.fromEntries(
        field.fields.map((f) => [f.key, initialScalar(f, isRecord(d) && f.key in d ? d[f.key] : f.default)]),
      );
    default:
      return initialScalar(field, d);
  }
}

function initialScalar(field: ScalarField, d: unknown): ScalarValue {
  switch (field.kind) {
    case "string":
    case "datetime":
      return typeof d === "string" ? d : "";
    case "number":
    case "integer":
      return typeof d === "number" ? String(d) : "";
    case "boolean":
      return typeof d === "boolean" ? d : field.required ? false : undefined;
    case "enum": {
      const i = field.options?.findIndex((o) => o === d) ?? -1;
      return i >= 0 ? String(i) : "";
    }
    case "json":
      return d === undefined ? "" : JSON.stringify(d, null, 2);
  }
}

/** A field's name in the form: `title`, `details.email`, `links[0]`, `people[0].name`. */
export const pathName = (path: readonly (string | number)[]) =>
  path.reduce<string>((name, p) => (typeof p === "number" ? `${name}[${p}]` : name ? `${name}.${p}` : p), "");

/**
 * The input to send, or the fields whose values can't be read, by field name. Optional fields
 * left empty are left out, so the workflow's defaults apply; an empty required text field is
 * sent as "", so the schema says what it needs.
 */
export function buildInput(
  fields: Field[],
  values: Values,
): { input: Record<string, unknown>; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const input = readObject(fields, values, [], errors);
  return { input, errors };
}

const OMIT = Symbol("omit");

function readObject(
  fields: Field[],
  values: Record<string, unknown>,
  path: (string | number)[],
  errors: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = read(field, values[field.key], [...path, field.key], errors);
    if (value !== OMIT) out[field.key] = value;
  }
  return out;
}

function read(field: Field, raw: unknown, path: (string | number)[], errors: Record<string, string>): unknown {
  switch (field.kind) {
    case "array": {
      const items = Array.isArray(raw) ? raw : [];
      if (!items.length && !field.required) return OMIT;
      return items.map((item, i) => {
        const value = read(field.item, item, [...path, i], errors);
        return value === OMIT ? null : value;
      });
    }
    case "object": {
      const values = isRecord(raw) ? raw : {};
      // An optional object left as it started is left out, even when a field in it is required:
      // the person did not fill it in, which is not the same as filling in an empty name. As it
      // started, not empty: a required yes/no starts as false.
      const untouched = (f: ScalarField) =>
        values[f.key] === undefined || values[f.key] === initialScalar(f, f.default);
      if (!field.required && field.fields.every(untouched)) return OMIT;
      const obj = readObject(field.fields, values, path, errors);
      return Object.keys(obj).length || field.required ? obj : OMIT;
    }
    default:
      return readScalar(field, raw, pathName(path), errors);
  }
}

function readScalar(field: ScalarField, raw: unknown, name: string, errors: Record<string, string>): unknown {
  if (field.kind === "boolean") return typeof raw === "boolean" ? raw : OMIT;
  const text = typeof raw === "string" ? raw : "";
  if (field.kind === "string") return text !== "" || field.required ? text : OMIT;
  if (!text.trim()) return OMIT;
  switch (field.kind) {
    // Already ISO (`DateTimeInput`): the server's schema says whether it is a date and time.
    case "datetime":
      return text;
    case "number":
    case "integer": {
      const n = Number(text);
      if (Number.isFinite(n)) return n;
      errors[name] = "Not a number";
      return OMIT;
    }
    case "enum":
      return field.options?.[Number(text)];
    case "json":
      try {
        return JSON.parse(text);
      } catch {
        errors[name] = "Not valid JSON";
        return OMIT;
      }
  }
}

/**
 * Where a schema issue belongs: the deepest field the form shows on its path, and the message,
 * prefixed with the rest of the path when the issue is inside a JSON field. Undefined when the
 * path names no field (the issue is about the whole input).
 */
export function issueTarget(
  fields: Field[],
  path: readonly (string | number)[],
  message: string,
): { name: string; message: string } | undefined {
  const [head, ...rest] = path;
  const field = fields.find((f) => f.key === head);
  if (!field || typeof head !== "string") return undefined;
  let shown: (string | number)[] = [head];
  let remaining = rest;
  if (field.kind === "array" && typeof rest[0] === "number") {
    shown = [head, rest[0]];
    remaining = rest.slice(1);
    if (field.item.kind === "object") [shown, remaining] = into(field.item.fields, shown, remaining);
  } else if (field.kind === "object") {
    [shown, remaining] = into(field.fields, shown, remaining);
  }
  return { name: pathName(shown), message: remaining.length ? `${pathName(remaining)}: ${message}` : message };
}

function into(
  fields: ScalarField[],
  shown: (string | number)[],
  remaining: (string | number)[],
): [(string | number)[], (string | number)[]] {
  const [next, ...rest] = remaining;
  return fields.some((f) => f.key === next) ? [[...shown, next as string], rest] : [shown, remaining];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** An ISO time as a `datetime-local` value, in this browser's time zone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value as an ISO time with this browser's offset, such as 2026-10-07T09:30:00+02:00. */
export function fromLocalInput(value: string): string | undefined {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
