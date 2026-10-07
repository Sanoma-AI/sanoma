/**
 * A start form from a workflow's input JSON Schema. Top-level object properties of a simple
 * type get their own control; anything else is edited as JSON. Optional fields left empty are
 * left out of the input, so the workflow's zod defaults apply.
 */

export type FieldKind = "string" | "datetime" | "number" | "integer" | "boolean" | "enum" | "json";

export interface Field {
  name: string;
  kind: FieldKind;
  required: boolean;
  label: string;
  description?: string;
  default?: unknown;
  /** For an enum: the allowed values. */
  options?: unknown[];
}

/** What the form holds per field: text for most, a checkbox state for booleans (undefined until touched). */
export type Value = string | boolean | undefined;

type Schema = Record<string, unknown>;

const isRecord = (x: unknown): x is Schema => typeof x === "object" && x !== null && !Array.isArray(x);

/** The schema's top-level fields, or undefined when the input is not an object with properties. */
export function fieldsOf(schema: Schema): Field[] | undefined {
  if (schema.type !== "object" || !isRecord(schema.properties)) return undefined;
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(schema.properties).map(([name, raw]) => {
    const prop = isRecord(raw) ? raw : {};
    const kind = kindOf(prop);
    return {
      name,
      kind,
      required: required.has(name),
      label: typeof prop.title === "string" ? prop.title : name,
      ...(typeof prop.description === "string" ? { description: prop.description } : {}),
      ...("default" in prop ? { default: prop.default } : {}),
      ...(kind === "enum" ? { options: prop.enum as unknown[] } : {}),
    };
  });
}

function kindOf(prop: Schema): FieldKind {
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

export function initialValue(field: Field): Value {
  const d = field.default;
  switch (field.kind) {
    case "string":
      return typeof d === "string" ? d : "";
    case "datetime":
      return typeof d === "string" ? toLocalInput(d) : "";
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

/** The input to send, or the fields whose values cannot be read. */
export function buildInput(
  fields: Field[],
  values: Record<string, Value>,
): { input: Record<string, unknown>; errors: Record<string, string> } {
  const input: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (field.kind === "boolean") {
      if (typeof raw === "boolean") input[field.name] = raw;
      continue;
    }
    const text = typeof raw === "string" ? raw : "";
    // An empty required text field is sent as "", so the schema says what it needs.
    if (field.kind === "string") {
      if (text !== "" || field.required) input[field.name] = text;
      continue;
    }
    if (!text.trim()) continue;
    switch (field.kind) {
      case "datetime": {
        const iso = fromLocalInput(text);
        if (iso) input[field.name] = iso;
        else errors[field.name] = "Not a date and time";
        break;
      }
      case "number":
      case "integer": {
        const n = Number(text);
        if (Number.isFinite(n)) input[field.name] = n;
        else errors[field.name] = "Not a number";
        break;
      }
      case "enum":
        input[field.name] = field.options?.[Number(text)];
        break;
      case "json":
        try {
          input[field.name] = JSON.parse(text);
        } catch {
          errors[field.name] = "Not valid JSON";
        }
        break;
    }
  }
  return { input, errors };
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
