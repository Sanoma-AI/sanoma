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

/** An import ID as a directory name: `repo:main` becomes `repo_main`. */
export const slug = (id: string) => id.replaceAll(/[^A-Za-z0-9._-]+/g, "_");

export const toPath = (dir: string | URL) => (typeof dir === "string" ? dir : fileURLToPath(dir));

export const schemaFile = (dir: string, ref: ProviderRef) => join(dir, "schemas", `${releaseSlug(ref)}.json`);

export const typeDir = (dir: string, ref: ProviderRef, typeName: string) =>
  join(dir, "replies", releaseSlug(ref), typeName);

export const replyDir = (dir: string, ref: ProviderRef, typeName: string, id: string) =>
  join(typeDir(dir, ref, typeName), slug(id));

/** The `id` attribute of a resource's state, which every provider sets; `undefined` if there is none. */
export function stateId(stateJson: string): string | undefined {
  const id = (JSON.parse(stateJson) as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

/** How to (re-)record a missing fixture, for error messages. */
export const recordHint = "record it with SANOMA_LIVE=1 SANOMA_RECORD=1 (see packages/bridge/AGENTS.md)";
