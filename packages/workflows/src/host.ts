import type { z } from "zod";

// The `Host` contract: what a resource type that runs the company (a container, a Render service,
// a Fly app) declares about itself, so hosts are swappable and one conformance kit decides
// whether one works. A host is a resource type like any other; this is what sets it apart.

/** How a host keeps the runtime up: `long-lived`, or (later) woken on a schedule. */
export type HostLifetime = "long-lived" | "wake-on-schedule";

/** What a host can do, for choosing one. */
export interface HostCapabilities {
  lifetime: HostLifetime;
  /** Its `url` is reachable from the internet, not only from this machine. */
  publicUrl: boolean;
  /** It builds the repository from git itself, at the revision apply gives it. */
  buildsFromGit: boolean;
  /** Its outbound connections come from fixed addresses, for a vendor's allow-list. */
  staticEgress: boolean;
}

/** What a host's state says of it: where the app answers, which commit it runs, and whether it is up. */
export interface HostOutputs {
  url: string;
  /** The commit it runs, when its state says. */
  revision?: string;
  healthy: boolean;
}

/**
 * A resource type's `host`: the fields it takes the runtime's inputs in, by dotted path into its
 * declared fields, and how its state reads as `HostOutputs`. A host is drifted when
 * `outputs(state).revision` differs from what `sanoma.source.resolve` says `ref` is now.
 */
export interface HostSpec {
  capabilities: HostCapabilities;
  inputs: {
    /** The repository's clone URL, or a reference to a declared repository whose state holds one (a `by` field). */
    source: string;
    /** The branch (or tag) it runs: `main`, never a commit. */
    ref: string;
    /** The secrets it passes the runtime (`SANOMA_DATABASE_URL`, `SANOMA_SECRETS_KEY`): a write-only field. */
    secrets: string;
    /** The port the app listens on. */
    port: string;
    /** A public site's domain, by site name: the app serves each site at the root of its domain (`SANOMA_DOMAINS`). */
    domains?: string;
  };
  /**
   * The field apply fills with the commit `ref` resolves to, before it plans: hidden, as a data
   * file may not declare it, so a merge to `ref` is a change to the host.
   */
  revision: string;
  outputs: (state: Record<string, unknown>) => HostOutputs;
}

const LIFETIMES: readonly HostLifetime[] = ["long-lived", "wake-on-schedule"];

/** True when `schema` has a field at the dotted `path`, looking through optional, nullable and default wrappers. */
function hasPath(schema: z.ZodType, path: string): boolean {
  let at: z.ZodType | undefined = schema;
  for (const key of path.split(".")) {
    at = unwrap(at);
    const shape = (at as Partial<z.ZodObject>).shape;
    at = shape?.[key];
    if (!at) return false;
  }
  return true;
}

function unwrap(schema: z.ZodType): z.ZodType {
  let at = schema;
  while ("unwrap" in at && typeof at.unwrap === "function") at = at.unwrap() as z.ZodType;
  return at;
}

/**
 * Throws what is wrong with a resource type's `host`: an input or `revision` that names no field,
 * `secrets` that is not write-only, a `revision` that is, an unknown lifetime, a type apply cannot
 * change (not `writable`).
 */
export function checkHost(
  what: string,
  host: HostSpec,
  type: { schema: z.ZodObject; fields: { writeOnly: readonly string[] }; writable?: boolean },
): void {
  const problems: string[] = [];
  if (!type.writable) problems.push("it must be writable, so apply can create and update it");
  if (!LIFETIMES.includes(host.capabilities?.lifetime)) {
    problems.push(`capabilities.lifetime is one of ${LIFETIMES.join(", ")}`);
  }
  for (const [input, path] of [...Object.entries(host.inputs ?? {}), ["revision", host.revision] as const]) {
    if (typeof path !== "string" || !hasPath(type.schema, path)) problems.push(`${input} names no field (${path})`);
  }
  if (!type.fields.writeOnly.includes(host.inputs?.secrets)) problems.push("inputs.secrets must be a write-only field");
  if (type.fields.writeOnly.includes(host.revision)) problems.push("revision must not be write-only: drift reads it");
  if (typeof host.outputs !== "function") problems.push("outputs must be a function of the state");
  if (problems.length) throw new Error(`${what}: its host: ${problems.join("; ")}`);
}
