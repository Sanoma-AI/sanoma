import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderRef } from "./bridge.ts";

/**
 * A recorded call, `replies/<ns>_<type>_<version>/<resource type>/<id slug>/{import,read}.json`:
 * `request` and `response` are the bridge's messages in Connect's JSON form, or, for a call that
 * failed, `response: { error: { code, message, diagnostics } }`. `scrubbed` lists the attribute
 * paths whose values were replaced by `"<scrubbed>"` and the secrets replaced everywhere.
 */
export interface Fixture {
  provider: { source: string; version: string; sha256: string; protocol: number };
  request: Record<string, unknown>;
  response: Record<string, unknown> | { error: FixtureError };
  scrubbed: string[];
}

export interface FixtureError {
  code: string;
  message: string;
  diagnostics: Record<string, unknown>[];
}

export const isError = (response: Fixture["response"]): response is { error: FixtureError } => "error" in response;

/** The bridge's name for a release in messages: `integrations/github 6.13.0`. */
export const releaseName = (ref: ProviderRef) => `${ref.source} ${ref.version}`;

/** `integrations_github_6.13.0`: the release's file and directory name (any registry host is dropped). */
export function releaseSlug({ source, version }: ProviderRef): string {
  const [type = "", namespace = ""] = source.split("/").toReversed();
  return `${namespace}_${type}_${version}`;
}

export const toPath = (dir: string | URL) => (typeof dir === "string" ? dir : fileURLToPath(dir));

export const schemaFile = (dir: string, ref: ProviderRef) => join(dir, "schemas", `${releaseSlug(ref)}.json`);

/** The `id` attribute of a resource's state (JSON, or parsed), which every provider sets; `undefined` if there is none. */
export function stateId(state: string | Record<string, unknown>): string | undefined {
  const { id } = (typeof state === "string" ? JSON.parse(state) : state) as { id?: unknown };
  return typeof id === "string" ? id : undefined;
}
