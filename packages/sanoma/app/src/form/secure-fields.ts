/** Password controls for authentication input. No defaults or credential values in metadata. */
export interface SecureField {
  key: string;
  label: string;
  required: boolean;
  description?: string;
  json: boolean;
  root?: boolean;
}
export function secureFields(schema: Record<string, unknown>): SecureField[] {
  const properties = schema.properties;
  if (schema.type !== "object" || !properties || typeof properties !== "object" || Array.isArray(properties))
    return [{ key: "$value", label: "Credentials", required: true, json: schema.type !== "string", root: true }];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(properties).map(([key, value]) => {
    const field = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return {
      key,
      label: typeof field.title === "string" ? field.title : key,
      required: required.has(key),
      ...(typeof field.description === "string" && { description: field.description }),
      json: field.type !== "string",
    };
  });
}
export function secureInput(fields: SecureField[], values: Record<string, string>): unknown {
  const entries = fields
    .filter((field) => field.required || values[field.key])
    .map((field) => {
      const raw = values[field.key] ?? "";
      let value: unknown = raw;
      if (field.json) {
        try {
          value = JSON.parse(raw);
        } catch {
          throw new Error(`Enter valid JSON for ${field.label}`);
        }
      }
      return [field.key, value] as const;
    });
  return fields.length === 1 && fields[0]!.root ? entries[0]?.[1] : Object.fromEntries(entries);
}
