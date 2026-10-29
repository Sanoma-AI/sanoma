import { randomBytes } from "node:crypto";
import { DriverError } from "./op.ts";

// Secrets are named, never written: `secret("NAME")` in a data file is a marker for a value in
// the company's secrets store (the credentials table), allowed only at a write-only field. The
// marker is what declarations, checkpoints and the ledger hold; a driver resolves it
// (`resolveSecrets`) just before the vendor call. The `./resources` entry, which data files import
// `secret` from (`sanoma/resources` re-exports it).

/** What `secret()` makes: a plain object, so it reads the same as JSON and across copies of this package. */
export interface Secret {
  readonly $secret: string;
  /** When none is stored, apply makes the value (`generateSecret`) and stores it before the vendor call. */
  readonly generate?: true;
}

/** A secret's name: an environment variable's, upper case. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * True for one of sanoma's own secrets (`SANOMA_…`, its key and database URLs among them): only a
 * host, which runs the company, is given them, at its `secrets` input (`HostSpec`); never a vendor.
 */
export const isSanomaSecret = (name: string) => name.startsWith("SANOMA_");

/**
 * Names a stored secret for a write-only field of a data file: `secret("SUPABASE_DB_PASSWORD",
 * { generate: true })`. With `generate`, apply makes the value when none is stored.
 */
export function secret(name: string, options?: { generate: true }): Secret {
  if (!SECRET_NAME.test(name)) {
    throw new Error(`secret("${name}"): a secret's name is an environment variable's, upper case: A-Z, 0-9 and _`);
  }
  return Object.freeze(options?.generate ? { $secret: name, generate: true as const } : { $secret: name });
}

/** True for a secret marker, `{ $secret: "NAME" }`. */
export const isSecret = (value: unknown): value is Secret =>
  typeof value === "object" && value !== null && typeof (value as { $secret?: unknown }).$secret === "string";

/** The secrets store, as a driver sees it (`CallContext.secrets`). */
export interface Secrets {
  /** The stored value, or undefined when there is none. */
  get(name: string): Promise<string | undefined>;
  /** The stored value; when there is none, `make()`'s, stored first. */
  ensure(name: string, make: () => string): Promise<string>;
}

/** A named call can resolve only the auxiliary secret markers present in its authorized input. */
export function secretsForInput(input: unknown, secrets: Secrets): Secrets {
  const allowed = new Map<string, boolean>();
  const visit = (value: unknown) => {
    if (isSecret(value)) allowed.set(value.$secret, allowed.get(value.$secret) === true || value.generate === true);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(input);
  const check = (name: string, generate: boolean) => {
    if (!allowed.has(name) || (generate && !allowed.get(name)))
      throw new DriverError("The call does not authorize this secret access", { retryable: false });
  };
  return {
    async get(name) {
      check(name, false);
      return secrets.get(name);
    },
    async ensure(name, make) {
      check(name, true);
      return secrets.ensure(name, make);
    },
  };
}

/** A value for a secret with `generate`: 32 random bytes, base64url. */
export const generateSecret = (): string => randomBytes(32).toString("base64url");

/** `T` with each secret marker's place holding its value: what `resolveSecrets` returns. */
export type Resolved<T> = T extends Secret
  ? string
  : T extends readonly (infer I)[]
    ? Resolved<I>[]
    : T extends object
      ? { [K in keyof T]: Resolved<T[K]> }
      : T;

/**
 * `value` with each secret marker in it replaced by the stored value: generated and stored first
 * for one with `generate` and none stored. A marker naming nothing stored fails the call, for good.
 */
export async function resolveSecrets<T>(value: T, secrets: Secrets): Promise<Resolved<T>> {
  const resolve = async (v: unknown): Promise<unknown> => {
    if (isSecret(v)) {
      const stored = v.generate ? await secrets.ensure(v.$secret, generateSecret) : await secrets.get(v.$secret);
      if (stored === undefined) {
        throw new DriverError(`The secret ${v.$secret} is not set: store it before applying`, { retryable: false });
      }
      return stored;
    }
    if (Array.isArray(v)) return Promise.all(v.map(resolve));
    if (typeof v !== "object" || v === null) return v;
    const entries = await Promise.all(Object.entries(v).map(async ([k, item]) => [k, await resolve(item)] as const));
    return Object.fromEntries(entries);
  };
  return (await resolve(value)) as Resolved<T>;
}

/** A secrets store in memory, for fakes, sandbox runs and tests. */
export function memorySecrets(initial: Record<string, string> = {}): Secrets {
  const values = new Map(Object.entries(initial));
  return {
    get: async (name) => values.get(name),
    async ensure(name, make) {
      if (!values.has(name)) values.set(name, make());
      return values.get(name)!;
    },
  };
}
