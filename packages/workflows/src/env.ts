import type { z } from "zod";
import type { Driver, DriverEnv } from "./op.ts";
import { credentialReady } from "./shared.ts";

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
 * Each vendor's driver's `env` (a resolved config's `driversByVendor`), by vendor in the map's
 * order (a vendor whose driver declares none has no entry), each variable in declared order and
 * checked against the value `lookup` gives for its name: only the declared names are looked up,
 * an empty value counts as unset, and a value is never kept. The one walk of the declarations:
 * the worker, the client and its checks all read them through it.
 */
export function credentialsOf(
  drivers: ReadonlyMap<string, Driver>,
  lookup: (name: string) => string | undefined,
): Map<string, CredentialStatus[]> {
  const map = new Map<string, CredentialStatus[]>();
  for (const [vendor, { env }] of drivers) if (env) map.set(vendor, statusesOf(env, lookup));
  return map;
}

/** One driver's `env`, each variable checked against `lookup`'s value, as `credentialsOf` checks it. */
export function statusesOf(env: DriverEnv, lookup: (name: string) => string | undefined): CredentialStatus[] {
  return Object.entries(env.shape).map(([name, schema]) => credentialStatus(name, schema, lookup(name) || undefined));
}

/**
 * Why the vendor's drivers cannot run on `statuses`, as a call to one fails (`startWorker` names
 * the vendor alone, `unconfiguredSummary`): `<vendor> is not configured: <problems>; <hint>`, a
 * missing variable (not optional) as `NAME (description)`, an invalid one as `NAME is invalid:
 * <why>`, never a value. The hint says
 * where to set them: in the environment when an invalid value is there (the environment wins
 * over a stored value, so the connector page cannot replace it), else on the connector page.
 * Undefined when the drivers can run.
 */
export function unconfigured(vendor: string, statuses: readonly CredentialStatus[]): string | undefined {
  const unready = statuses.filter((c) => !credentialReady(c));
  if (!unready.length) return undefined;
  const problems = unready.map((c) =>
    c.status === "invalid"
      ? `${c.name} is invalid: ${c.problem}`
      : `${c.name}${c.description ? ` (${c.description})` : ""}`,
  );
  const inEnvironment = unready.some((c) => c.status === "invalid" && process.env[c.name]);
  const hint = inEnvironment ? "set in the environment" : "set it on the connector page";
  return `${vendor} is not configured: ${problems.join(", ")}; ${hint}`;
}

/**
 * The one line `startWorker` prints for the vendors whose drivers cannot run yet (`vendors`, those
 * `unconfigured` has a message for) among the config's `total`: their names alone, since a call
 * to one fails with its own message, and its connector page says the same. Undefined for none.
 */
export function unconfiguredSummary(vendors: readonly string[], total: number): string | undefined {
  if (!vendors.length) return undefined;
  return (
    `${vendors.length} of ${total} connectors not configured yet: ${vendors.join(", ")}; ` +
    "set their variables on the connector pages or in the environment"
  );
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
