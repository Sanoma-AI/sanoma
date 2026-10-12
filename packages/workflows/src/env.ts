import type { z } from "zod";
import type { Driver, DriverEnv } from "./op.ts";

// A driver's `env` against an environment: what each declared variable's status is, never its
// value. The worker, the client, the app and each live call read the declarations through here.

/** One environment variable a driver declares in `env`, and whether its value lets the driver run: never the value. */
export interface CredentialStatus {
  /** The variable's name, such as `GHOST_ADMIN_API_KEY`. */
  name: string;
  /** Its one-line manual, from its schema's `.describe()`. */
  description?: string;
  /** It may be unset. */
  optional: boolean;
  /** `missing` when unset or empty; `invalid` when its schema refuses the value. */
  status: "set" | "missing" | "invalid";
  /** Why it is `invalid`: the schema's first issue, never the value. */
  problem?: string;
  /**
   * Where the value is from, when there is one: the process environment, which wins, or the
   * credentials stored with `SanomaClient.setCredential`. Only `SanomaClient.credentials` says.
   */
  source?: "environment" | "stored";
  /** Who set the stored value (`setCredential`'s `by`). */
  setBy?: string;
  /** When the stored value was set, as an ISO 8601 time. */
  setAt?: string;
}

/**
 * Each driver's `env`, by vendor, in declared order (a vendor whose drivers declare none has no
 * entry), each variable checked against the value `lookup` gives for its name: only the declared
 * names are looked up, an empty value counts as unset, and a value is never kept. A variable two
 * drivers of one vendor declare is checked against each declaration, and the results merged. The
 * one walk of the declarations: the worker, the client and its checks all read them through it.
 */
export function credentialsOf(
  drivers: readonly Driver[],
  lookup: (name: string) => string | undefined,
): Map<string, CredentialStatus[]> {
  const map = new Map<string, CredentialStatus[]>();
  for (const { vendor, env } of drivers) {
    if (!env) continue;
    const list = map.get(vendor) ?? [];
    map.set(vendor, list);
    for (const [name, schema] of Object.entries(env.shape)) {
      const status = credentialStatus(name, schema, lookup(name) || undefined);
      const i = list.findIndex((c) => c.name === name);
      if (i === -1) list.push(status);
      else list[i] = merged(list[i]!, status);
    }
  }
  return map;
}

const SEVERITY: Record<CredentialStatus["status"], number> = { set: 0, missing: 1, invalid: 2 };

/**
 * Two declarations of one variable: the worse status (`invalid`, then `missing`) with its problem,
 * the first description, and optional only when both allow it unset.
 */
function merged(first: CredentialStatus, next: CredentialStatus): CredentialStatus {
  const worse = SEVERITY[next.status] > SEVERITY[first.status] ? next : first;
  const description = first.description ?? next.description;
  return { ...worse, ...(description !== undefined && { description }), optional: first.optional && next.optional };
}

function credentialStatus(
  name: string,
  schema: DriverEnv["shape"][string],
  value: string | undefined,
): CredentialStatus {
  const description = descriptionOf(schema);
  const parsed = value === undefined ? undefined : check(schema, value);
  const problem = parsed?.problem;
  return {
    name,
    ...(description !== undefined && { description }),
    optional: check(schema, undefined).success,
    status: !parsed ? "missing" : parsed.success ? "set" : "invalid",
    ...(problem !== undefined && { problem }),
  };
}

/**
 * `schema.safeParse(value)`, with its first issue's message as the problem. A check that throws
 * (zod lets a `.refine()` or `.transform()` throw) fails without its error, which may carry the value.
 */
function check(schema: z.ZodType, value: string | undefined): { success: boolean; problem?: string } {
  try {
    const { success, error } = schema.safeParse(value);
    return { success, ...(error && { problem: error.issues[0]!.message }) };
  } catch {
    return { success: false, problem: "its check threw" };
  }
}

/** A schema's `.describe()`, also through `.optional()`, `.default()` and `.prefault()` in any order. */
function descriptionOf(schema: z.ZodType): string | undefined {
  let s: z.ZodType | undefined = schema;
  while (s && !s.description) s = "unwrap" in s ? (s as { unwrap(): z.ZodType }).unwrap() : undefined;
  return s?.description;
}
