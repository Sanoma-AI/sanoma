import type { z } from "zod";
import { SecretStoreError, type SecretStoreCapabilities } from "./secret-store.ts";

/** Credential schemas and lifecycle are owned by authentication, never by the store provider. */
export type Authentication<S extends z.ZodType = z.ZodType> =
  | {
      kind: "api-key" | "fields" | "oauth2" | "signed";
      version: number;
      schema: S;
      storage: { writable: boolean; maxBytes: number; conditionalWrites: boolean };
    }
  | { kind: "workload-identity"; storage?: never; version?: never; schema?: never };

export function defineAuthentication<S extends z.ZodType>(definition: Authentication<S>): Authentication<S> {
  if (definition.kind === "workload-identity") {
    if (definition.storage !== undefined || definition.schema !== undefined || definition.version !== undefined)
      throw new SecretStoreError("invalid_configuration");
    return Object.freeze({ kind: "workload-identity" });
  }
  if (
    !["api-key", "fields", "oauth2", "signed"].includes(definition.kind) ||
    !Number.isSafeInteger(definition.version) ||
    definition.version < 1 ||
    typeof definition.schema?.safeParse !== "function" ||
    !definition.storage ||
    !Number.isSafeInteger(definition.storage.maxBytes) ||
    definition.storage.maxBytes < 1 ||
    typeof definition.storage.writable !== "boolean" ||
    typeof definition.storage.conditionalWrites !== "boolean"
  ) {
    throw new SecretStoreError("invalid_configuration");
  }
  return Object.freeze({ ...definition, storage: Object.freeze({ ...definition.storage }) });
}

/** Compatibility check before consent, including externally renewed (read-only) OAuth bundles. */
export function checkAuthenticationStore(
  auth: Authentication,
  store: SecretStoreCapabilities,
  management: "sanoma" | "external",
): void {
  if (auth.kind === "workload-identity") return;
  if (auth.storage.maxBytes > store.maxBytes) throw new SecretStoreError("too_large");
  if (auth.storage.writable && (management === "external" || !store.writable)) throw new SecretStoreError("read_only");
  if (auth.storage.conditionalWrites && store.conditionalWrites === "none") throw new SecretStoreError("unsupported");
}

/** Serialized only at the trusted store boundary, never returned by an operation to a workflow. */
export function encodeCredentials<S extends z.ZodType>(auth: Authentication<S>, value: z.input<S>): string {
  if (auth.kind === "workload-identity") throw new SecretStoreError("unsupported");
  try {
    const parsed = auth.schema.safeParse(value);
    if (!parsed.success) throw new SecretStoreError("invalid_value");
    const encoded = JSON.stringify({ version: auth.version, value: parsed.data });
    if (Buffer.byteLength(encoded) > auth.storage.maxBytes) throw new SecretStoreError("too_large");
    return encoded;
  } catch (error) {
    if (error instanceof SecretStoreError) throw new SecretStoreError(error.code);
    throw new SecretStoreError("invalid_value");
  }
}

export function decodeCredentials<S extends z.ZodType>(auth: Authentication<S>, encoded: string): z.output<S> {
  if (auth.kind === "workload-identity") throw new SecretStoreError("unsupported");
  try {
    if (Buffer.byteLength(encoded) > auth.storage.maxBytes) throw new SecretStoreError("too_large");
    const bundle = JSON.parse(encoded);
    if (bundle?.version !== auth.version) throw new SecretStoreError("invalid_value");
    return auth.schema.parse(bundle.value);
  } catch (error) {
    if (error instanceof SecretStoreError) throw new SecretStoreError(error.code);
    throw new SecretStoreError("invalid_value");
  }
}
