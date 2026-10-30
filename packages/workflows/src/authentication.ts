import type { z } from "zod";
import type { CallContext } from "./op.ts";
import { SecretStoreError, type SecretStoreCapabilities } from "./secret-store.ts";

/** Facts verified with the provider, not account claims supplied by the caller. */
export interface AuthenticationIdentity {
  account: string;
  scopes: readonly string[];
  /** Unix time in milliseconds. Missing means the provider gives no expiry. */
  expiresAt?: number;
}

export type AuthenticationProblem =
  | "missing"
  | "expired"
  | "revoked"
  | "rejected"
  | "wrong_account"
  | "scope_changed"
  | "uncertain"
  | "unavailable"
  | "unsupported";

/** Safe lifecycle information only: never a provider response, cause or credential. */
export class AuthenticationError extends Error {
  readonly code = "authentication_failed";
  readonly retryable: boolean;
  readonly problem: AuthenticationProblem;
  constructor(problem: AuthenticationProblem) {
    super(`Authentication: ${problem}`);
    this.problem = problem;
    this.name = "AuthenticationError";
    this.retryable = problem === "unavailable";
  }
}

const authenticationProblems = new Set<AuthenticationProblem>([
  "missing",
  "expired",
  "revoked",
  "rejected",
  "wrong_account",
  "scope_changed",
  "uncertain",
  "unavailable",
  "unsupported",
]);

export function authenticationProblem(error: unknown): AuthenticationProblem | undefined {
  const failure = error as Partial<AuthenticationError> | null;
  return failure?.name === "AuthenticationError" && authenticationProblems.has(failure.problem!)
    ? failure.problem
    : undefined;
}

/** Shared by credential intake and execution; unknown provider failures never imply revocation. */
export async function verifyAuthentication(
  method: Authentication,
  credentials?: unknown,
): Promise<AuthenticationIdentity> {
  if (!method.verify) throw new AuthenticationError("unsupported");
  try {
    const identity = await method.verify(credentials);
    if (
      typeof identity?.account !== "string" ||
      !identity.account.trim() ||
      !Array.isArray(identity.scopes) ||
      identity.scopes.some((scope) => typeof scope !== "string") ||
      (identity.expiresAt !== undefined && !Number.isFinite(identity.expiresAt))
    )
      throw new AuthenticationError("unavailable");
    if (identity.expiresAt !== undefined && identity.expiresAt <= Date.now()) throw new AuthenticationError("expired");
    return {
      account: identity.account,
      scopes: [...new Set(identity.scopes)].toSorted(),
      ...(identity.expiresAt !== undefined && { expiresAt: identity.expiresAt }),
    };
  } catch (error) {
    // Structural recognition works across installed copies. Rebuild even recognized errors so
    // an SDK message, stack or cause attached by a verifier cannot cross this boundary.
    throw new AuthenticationError(authenticationProblem(error) ?? "unavailable");
  }
}

/** Ephemeral material for one authorized driver invocation; never checkpoint this object. */
export interface CallAuthentication {
  method: string;
  kind: Authentication["kind"];
  credentialVersion?: string;
  credentials?: unknown;
}

/** Credential schemas and lifecycle are owned by authentication, never by the store provider. */
export type Authentication<S extends z.ZodType = z.ZodType> =
  | {
      kind: "api-key" | "fields" | "oauth2" | "signed";
      version: number;
      schema: S;
      storage: { writable: boolean; maxBytes: number; conditionalWrites: boolean };
      verify?(credentials: z.output<S>): Promise<AuthenticationIdentity>;
    }
  | {
      kind: "workload-identity";
      storage?: never;
      version?: never;
      schema?: never;
      verify?(): Promise<AuthenticationIdentity>;
    };

export function defineAuthentication<S extends z.ZodType>(definition: Authentication<S>): Authentication<S> {
  if (definition.verify !== undefined && typeof definition.verify !== "function")
    throw new SecretStoreError("invalid_configuration");
  if (definition.kind === "workload-identity") {
    if (definition.storage !== undefined || definition.schema !== undefined || definition.version !== undefined)
      throw new SecretStoreError("invalid_configuration");
    return Object.freeze({ ...definition });
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

/** Typed access inside a driver. A missing or different method never falls back to the environment. */
export function authenticationCredentials<S extends z.ZodType>(
  method: string,
  definition: Authentication<S>,
  call: CallContext,
): z.output<S> {
  if (
    definition.kind === "workload-identity" ||
    call.authentication?.method !== method ||
    call.authentication.kind !== definition.kind
  )
    throw new SecretStoreError("unsupported");
  try {
    return definition.schema.parse(call.authentication.credentials);
  } catch {
    throw new SecretStoreError("invalid_value");
  }
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
