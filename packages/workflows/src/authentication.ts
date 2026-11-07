import { z } from "zod";
import type { CallContext } from "./op.ts";
import { SecretStoreError, type SecretStoreCapabilities } from "./secret-store.ts";
import { isLoopback } from "./shared.ts";

/** Facts verified with the provider, not account claims supplied by the caller. */
export interface AuthenticationIdentity {
  account: string;
  scopes: readonly string[];
  /** Unix time in milliseconds. Missing means the provider gives no expiry. */
  expiresAt?: number;
}

/** Server-selected account reference for deployment-bound workload identity resolution. */
export interface AuthenticationContext {
  readonly connectionId: string;
  readonly vendor: string;
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
  context?: AuthenticationContext,
): Promise<AuthenticationIdentity> {
  if (!method.verify) throw new AuthenticationError("unsupported");
  try {
    const identity = await (method.kind === "workload-identity"
      ? method.verify(context)
      : (method.verify as (credentials: unknown) => Promise<AuthenticationIdentity>)(credentials));
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
  /** Unix ms when the verified credential stops working, when its verifier says. */
  expiresAt?: number;
}

/**
 * The grant an `oauth2` method stores for a connection: what the token endpoint answered, as one
 * versioned bundle that the exchange (and, with #467, a refresh) replaces whole. `expiresAt` is
 * Unix time in milliseconds; `scopes` only when the provider's answer named them.
 */
export const oauthGrant = z.object({
  accessToken: z.string().min(1),
  tokenType: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().int().optional(),
  scopes: z.array(z.string()).optional(),
});
export type OAuthGrant = z.output<typeof oauthGrant>;

/**
 * A provider's authorization-code flow (RFC 6749, with PKCE S256 from RFC 7636), declared by the
 * connector. The application's client id and secret are not here: they are the company's, stored
 * as the connection's `client` secret, distinct from each account's grant.
 */
export interface OAuthFlow {
  /** The authorization endpoint the person consents at: https, or http on this machine. */
  authorizeUrl: string;
  /** The token endpoint the exchange posts the code to: https, or http on this machine. */
  tokenUrl: string;
  /** Sent as `scope`; empty when the provider takes scopes from the application's settings. */
  scopes: readonly string[];
  /** Send an S256 code challenge and the verifier with the code. */
  pkce: boolean;
  /** How the token request authenticates the application: HTTP Basic, or form fields. */
  clientAuthentication: "client_secret_basic" | "client_secret_post";
  /**
   * How the provider renews a grant: declared for #467, which runs it. Until then an expired grant
   * is `expired`, and Reconnect obtains a new one.
   */
  refresh?: "refresh_token";
}

/** Credential schemas and lifecycle are owned by authentication, never by the store provider. */
export type Authentication<S extends z.ZodType = z.ZodType> =
  | StoredAuthentication<S>
  | OAuthAuthentication
  | WorkloadAuthentication;

/** A bundle a person enters (a key, fields, a signing key), kept in the store as one value. */
export interface StoredAuthentication<S extends z.ZodType = z.ZodType> {
  kind: "api-key" | "fields" | "signed";
  version: number;
  schema: S;
  storage: { writable: boolean; maxBytes: number; conditionalWrites: boolean };
  oauth?: never;
  verify?(credentials: z.output<S>): Promise<AuthenticationIdentity>;
}

/** The deployment's own identity: no stored bundle. */
export interface WorkloadAuthentication {
  kind: "workload-identity";
  storage?: never;
  version?: never;
  schema?: never;
  oauth?: never;
  verify?(context?: AuthenticationContext): Promise<AuthenticationIdentity>;
}

/** An `oauth2` method: its bundle is always `oauthGrant`, written by the runtime's exchange. */
export interface OAuthAuthentication {
  kind: "oauth2";
  version: number;
  schema: typeof oauthGrant;
  /** The runtime writes every grant, so the store must be writable with conditional writes. */
  storage: { writable: true; maxBytes: number; conditionalWrites: true };
  oauth: OAuthFlow;
  /** Establishes the account (and expiry) a grant authorizes, with the provider. */
  verify?(grant: OAuthGrant): Promise<AuthenticationIdentity>;
}

/** An endpoint a flow may name: https, or plain http to this machine (a test's provider). */
const endpoint = (value: unknown) => {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  } catch {
    return false;
  }
};

export function defineAuthentication(definition: Omit<OAuthAuthentication, "schema">): OAuthAuthentication;
export function defineAuthentication<S extends z.ZodType>(definition: StoredAuthentication<S>): StoredAuthentication<S>;
export function defineAuthentication(definition: WorkloadAuthentication): WorkloadAuthentication;
export function defineAuthentication(definition: Authentication): Authentication;
export function defineAuthentication(definition: Authentication | Omit<OAuthAuthentication, "schema">): Authentication {
  if (definition.verify !== undefined && typeof definition.verify !== "function")
    throw new SecretStoreError("invalid_configuration");
  if (definition.kind === "workload-identity") {
    if (definition.storage !== undefined || definition.schema !== undefined || definition.version !== undefined)
      throw new SecretStoreError("invalid_configuration");
    return Object.freeze({ ...definition });
  }
  const { storage, oauth } = definition;
  const schema = definition.kind === "oauth2" ? oauthGrant : definition.schema;
  if (
    !["api-key", "fields", "oauth2", "signed"].includes(definition.kind) ||
    !Number.isSafeInteger(definition.version) ||
    definition.version < 1 ||
    typeof schema?.safeParse !== "function" ||
    !storage ||
    !Number.isSafeInteger(storage.maxBytes) ||
    storage.maxBytes < 1 ||
    typeof storage.writable !== "boolean" ||
    typeof storage.conditionalWrites !== "boolean" ||
    (definition.kind === "oauth2"
      ? !storage.writable ||
        !storage.conditionalWrites ||
        !endpoint(oauth?.authorizeUrl) ||
        !endpoint(oauth?.tokenUrl) ||
        !Array.isArray(oauth?.scopes) ||
        oauth.scopes.some((scope) => typeof scope !== "string" || !scope || /\s/.test(scope)) ||
        typeof oauth.pkce !== "boolean" ||
        !["client_secret_basic", "client_secret_post"].includes(oauth.clientAuthentication) ||
        (oauth.refresh !== undefined && oauth.refresh !== "refresh_token")
      : oauth !== undefined)
  ) {
    throw new SecretStoreError("invalid_configuration");
  }
  return Object.freeze({
    ...definition,
    schema,
    storage: Object.freeze({ ...storage }),
    ...(oauth && { oauth: Object.freeze({ ...oauth, scopes: Object.freeze([...oauth.scopes]) }) }),
  }) as Authentication;
}

/** Typed access inside a driver. A missing or different method never falls back to the environment. */
export function authenticationCredentials<A extends Authentication<any>>(
  method: string,
  definition: A,
  call: CallContext,
): A extends { schema: infer S extends z.ZodType } ? z.output<S> : never {
  if (
    definition.kind === "workload-identity" ||
    call.authentication?.method !== method ||
    call.authentication.kind !== definition.kind
  )
    throw new SecretStoreError("unsupported");
  try {
    return definition.schema.parse(call.authentication.credentials) as never;
  } catch {
    throw new SecretStoreError("invalid_value");
  }
}

/** Why a store cannot keep a method's credentials: `checkAuthenticationStore`'s refusal (`STORAGE_PROBLEMS` in `shared.ts` says each). */
export type AuthenticationStoreProblem = "too_large" | "read_only" | "unsupported";

/** Compatibility before consent, including externally renewed (read-only) OAuth bundles: the refusal, none when they fit. */
export function authenticationStoreProblem(
  auth: Authentication,
  store: SecretStoreCapabilities,
  management: "sanoma" | "external",
): AuthenticationStoreProblem | undefined {
  if (auth.kind === "workload-identity") return undefined;
  if (auth.storage.maxBytes > store.maxBytes) return "too_large";
  if (auth.storage.writable && (management === "external" || !store.writable)) return "read_only";
  if (auth.storage.conditionalWrites && store.conditionalWrites === "none") return "unsupported";
  return undefined;
}

/** `authenticationStoreProblem`'s refusal thrown, for the paths that must not go on. */
export function checkAuthenticationStore(
  auth: Authentication,
  store: SecretStoreCapabilities,
  management: "sanoma" | "external",
): void {
  const problem = authenticationStoreProblem(auth, store, management);
  if (problem) throw new SecretStoreError(problem);
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
    return auth.schema.parse(bundle.value) as z.output<S>;
  } catch (error) {
    if (error instanceof SecretStoreError) throw new SecretStoreError(error.code);
    throw new SecretStoreError("invalid_value");
  }
}
