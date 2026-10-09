import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { BridgeError, type BridgeErrorCode, type ProviderRef, type ResourceState, toDiagnostic } from "./bridge.ts";
import type { ProviderClient } from "./configure.ts";
import { type Fixture, type FixtureError, isError, releaseName, releaseSlug, stateId, toPath } from "./fixtures.ts";
import { DiagnosticSchema } from "./gen/bridge/v1/bridge_pb.ts";
import type { JsonObject } from "./json.ts";

/** A call a fake bridge received, in order. */
export interface BridgeCall {
  method: "schema" | "configure" | "import" | "read" | "close";
  ref?: ProviderRef;
  typeName?: string;
  /** The import ID, or the `id` in a read's state. */
  id?: string;
}

/** One object a `stateBridge` serves: its state as the provider holds it, its private data (base64) and state version. */
export interface StateObject {
  typeName: string;
  state: JsonObject;
  private: string;
  schemaVersion: number;
}

/** What a `stateBridge` answers an import of an object with: the bridge's error, as recorded. */
export interface StateFailure {
  error: FixtureError;
}

/** What a `stateBridge` serves: objects, or failed imports, by `<typeName>/<import id>`. Plain JSON, so a fake can keep it in a file. */
export interface BridgeState {
  objects: Record<string, StateObject | StateFailure>;
}

const isFailure = (o: StateObject | StateFailure): o is StateFailure => "error" in o;

/** A `Resource` as a fixture holds it, in Connect's JSON form: int64 as a string, bytes as base64. */
interface ReplyResource {
  typeName: string;
  stateJson: string;
  private?: string;
  schemaVersion?: string | number;
}

const objectOf = (r: ReplyResource): StateObject => ({
  typeName: r.typeName,
  state: JSON.parse(r.stateJson) as JsonObject,
  private: r.private ?? "",
  schemaVersion: Number(r.schemaVersion ?? 0),
});

const subdirs = (path: string) =>
  existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];

const loaded = new Map<string, BridgeState>();

/**
 * The recorded replies of a provider release under `fixtures` (`replies/<release>/<type>/<id>/`,
 * as `fakeBridge` reads them) as a `BridgeState`: each object by its type and import id, with
 * the state its `read.json` returned, else its import's; or the failure its import was answered
 * with. A folder with a read and no import (a read recorded on its own) is keyed by the `id` in
 * the read's state. Parsed once per directory; each call returns a fresh copy to change.
 */
export function loadReplies(fixtures: string | URL, ref: { source: string; version: string }): BridgeState {
  const root = join(toPath(fixtures), "replies", releaseSlug(ref));
  let state = loaded.get(root);
  if (!state) {
    const objects: BridgeState["objects"] = {};
    for (const type of subdirs(root)) {
      for (const folder of subdirs(join(root, type.name))) {
        const path = join(root, type.name, folder.name);
        const fixture = (name: string) =>
          existsSync(join(path, name)) ? (JSON.parse(readFileSync(join(path, name), "utf8")) as Fixture) : undefined;
        const imported = fixture("import.json");
        const read = fixture("read.json");
        const first = imported ?? read;
        if (!first) continue;
        const request = first.request as { typeName: string; id?: string; stateJson?: string };
        const id = imported ? request.id : stateId(request.stateJson ?? "{}");
        if (id === undefined) continue;
        const at = `${request.typeName}/${id}`;
        if (isError(first.response)) {
          objects[at] = { error: first.response.error };
          continue;
        }
        const reply =
          read && !isError(read.response)
            ? (read.response.resource as ReplyResource | undefined)
            : (first.response.resources as ReplyResource[] | undefined)?.[0];
        if (reply) objects[at] = objectOf(reply);
      }
    }
    state = { objects };
    loaded.set(root, state);
  }
  return structuredClone(state);
}

const failure = ({ code, message, diagnostics }: FixtureError) =>
  new BridgeError(
    code as BridgeErrorCode,
    message,
    diagnostics.map((d) => toDiagnostic(fromJson(DiagnosticSchema, d as JsonValue))),
  );

const resourceOf = (o: StateObject): ResourceState => ({
  typeName: o.typeName,
  stateJson: JSON.stringify(o.state),
  private: Buffer.from(o.private, "base64"),
  schemaVersion: o.schemaVersion,
});

/**
 * A bridge over `state`, for a connector's fake: `import` returns the object recorded under that
 * type and id (or its recorded failure, or `not_found`), and `read` the object of that type whose
 * `id` is the state's, as it is in `state` now, or `gone` once it is not there. It reads `state`
 * on every call, so a test can change or remove an object between calls. Like the bridge, it
 * refuses an import or read before `configure` and another config until `close`, with real
 * `BridgeError`s. Every call is pushed onto `calls`.
 */
export function stateBridge(state: BridgeState, calls: BridgeCall[] = []): ProviderClient & { calls: BridgeCall[] } {
  const configured = new Map<string, string>();
  const ready = (ref: { source: string; version: string }) => {
    if (!configured.has(releaseName(ref))) {
      throw new BridgeError("failed_precondition", `${releaseName(ref)} is not configured; call Configure first`);
    }
  };
  return {
    calls,
    async configure(ref, configJson) {
      calls.push({ method: "configure", ref });
      const before = configured.get(releaseName(ref));
      if (before !== undefined && before !== configJson) {
        throw new BridgeError(
          "failed_precondition",
          `${releaseName(ref)} is already configured with a different config; Close it first`,
        );
      }
      configured.set(releaseName(ref), configJson);
      return { warnings: [] };
    },
    async import(ref, typeName, id) {
      calls.push({ method: "import", ref, typeName, id });
      ready(ref);
      const o = state.objects[`${typeName}/${id}`];
      if (!o) throw new BridgeError("not_found", `import ${typeName} "${id}": nothing recorded`);
      if (isFailure(o)) throw failure(o.error);
      return { resources: [resourceOf(o)], warnings: [] };
    },
    async read(ref, typeName, stateJson) {
      const id = stateId(stateJson);
      calls.push({ method: "read", ref, typeName, ...(id === undefined ? {} : { id }) });
      ready(ref);
      const found = Object.values(state.objects).find(
        (o): o is StateObject => !isFailure(o) && o.typeName === typeName && o.state.id === id,
      );
      return found ? { resource: resourceOf(found), gone: false, warnings: [] } : { gone: true, warnings: [] };
    },
    async close(ref) {
      calls.push({ method: "close", ...(ref ? { ref } : {}) });
      if (ref) configured.delete(releaseName(ref));
      else configured.clear();
    },
  };
}
