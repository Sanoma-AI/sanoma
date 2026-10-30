import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import type { ResourceFields } from "@sanoma-ai/workflows";
import {
  BridgeError,
  type BridgeErrorCode,
  type PlanAction,
  type PlanResult,
  type ProviderRef,
  type ResourceState,
  toDiagnostic,
} from "./bridge.ts";
import type { ProviderClient } from "./configure.ts";
import { type Fixture, type FixtureError, isError, releaseName, releaseSlug, stateId, toPath } from "./fixtures.ts";
import { DiagnosticSchema } from "./gen/bridge/v1/bridge_pb.ts";
import type { JsonObject } from "./json.ts";
import type { TfShape } from "./tfschema/types.ts";

const session = (ref: ProviderRef) => `${releaseName(ref)}/${ref.sessionId ?? ""}`;

/** A call a fake bridge received, in order. */
export interface BridgeCall {
  method: "schema" | "configure" | "import" | "read" | "plan" | "apply" | "close";
  ref?: ProviderRef;
  typeName?: string;
  /** The import ID, or the `id` in a read's state or a plan's or apply's prior state. */
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
// A type, not an interface, so it is a `Record<string, unknown>`, as `defineFake`'s state must be.
export type BridgeState = {
  objects: Record<string, StateObject | StateFailure>;
};

const isFailure = (o: StateObject | StateFailure): o is StateFailure => "error" in o;

/**
 * What a `stateBridge` knows of a resource type to plan and create one, by the provider's type
 * name, as its `TfResourceType` has it: `fields.vendorOwned` are unknown until applied, a change
 * to an `immutable` one (by top-level attribute) replaces the object, and a created object has
 * `schemaVersion`. With its `schema`, a created object's unknown attributes that take a string get
 * one; with its `shape`, a block the config leaves empty keeps the prior's, as a computed one would.
 */
export type StateTypes = Record<
  string,
  {
    schemaVersion: number;
    fields: Pick<ResourceFields, "vendorOwned" | "immutable">;
    schema?: { shape: Record<string, { safeParse(value: unknown): { success: boolean } }> };
    shape?: TfShape;
  }
>;

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
 * in provider-bridge's fixture format) as a `BridgeState`: each object by its type and import id, with
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

const parsed = (text: string | undefined) => (text ? (JSON.parse(text) as JsonObject) : undefined);

const topLevel = (paths: readonly string[]) => new Set(paths.map((path) => path.split(".")[0]));

/** A plan as `stateBridge` answers it: `planned` is the planned state's JSON; none for a delete. */
const planOf = (
  action: PlanAction,
  planned?: JsonObject,
  unknownPaths: string[] = [],
  requiresReplace: string[] = [],
) => {
  const plannedStateJson = planned ? JSON.stringify(planned) : "";
  return {
    action,
    plannedStateJson,
    unknownPaths,
    requiresReplace,
    planned: new TextEncoder().encode(plannedStateJson),
    planToken: new Uint8Array(),
    plannedPrivate: new Uint8Array(),
    warnings: [],
  } satisfies PlanResult;
};

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
 * refuses a call before `configure` and another config until `close`, with real `BridgeError`s.
 * Every call is pushed onto `calls`.
 *
 * `plan` diffs the config against the prior state as a provider might, with what `types` says
 * of the type (nothing: no unknowns but `id`, nothing replaces): a null in the config, or an empty
 * block, keeps the prior value, as for a computed attribute; a create plans `id` and the null `vendorOwned`
 * attributes unknown; a change to an `immutable` attribute is a replace. `planned` is the planned
 * state's JSON. `apply` puts the planned state into `state` (a created object gets the id
 * `<type>-<n>`, under that import id, and each other unknown its type's `schema` takes a string
 * at `<attribute>-<n>`, as a GitHub repository's `node_id`; the rest stay null), or, for a delete, removes
 * the object; an update of an object no longer there fails in `errors`, as a provider's would.
 */
export function stateBridge(
  state: BridgeState,
  calls: BridgeCall[] = [],
  types: StateTypes = {},
): ProviderClient & { calls: BridgeCall[] } {
  const configured = new Map<string, string>();
  const ready = (ref: ProviderRef) => {
    if (!configured.has(session(ref))) {
      throw new BridgeError("failed_precondition", `${releaseName(ref)} is not configured; call Configure first`);
    }
  };
  /** The object of type `typeName` whose provider id is `id`, and its key in `state.objects`. */
  const objectWithId = (typeName: string, id: unknown) =>
    Object.entries(state.objects).find(
      (entry): entry is [string, StateObject] =>
        !isFailure(entry[1]) && entry[1].typeName === typeName && entry[1].state.id === id,
    );
  const log = (method: "plan" | "apply", ref: ProviderRef, typeName: string, prior: JsonObject | undefined) => {
    const id = prior && stateId(prior);
    calls.push({ method, ref, typeName, ...(id === undefined ? {} : { id }) });
    ready(ref);
  };
  let created = 0;
  return {
    calls,
    async plan(ref, typeName, input) {
      const prior = parsed(input.priorStateJson);
      const config = parsed(input.configJson);
      log("plan", ref, typeName, prior);
      if (!config) {
        if (!prior) throw new BridgeError("invalid_argument", "prior_state_json or config_json is required");
        return planOf("delete");
      }
      const { vendorOwned = [], immutable = [] } = types[typeName]?.fields ?? {};
      const computed = topLevel(vendorOwned).add("id");
      const unknown = Object.keys(config).filter((name) => config[name] === null && computed.has(name));
      if (!prior) return planOf("create", config, unknown);
      const blocks = types[typeName]?.shape?.blocks ?? {};
      const unset = (name: string) =>
        config[name] === null || (Object.hasOwn(blocks, name) && isDeepStrictEqual(config[name], []));
      const changed = Object.keys(config).filter(
        (name) => !unset(name) && !isDeepStrictEqual(config[name], prior[name] ?? null),
      );
      const replaced = topLevel(immutable);
      const replace = changed.filter((name) => replaced.has(name));
      if (replace.length) return planOf("replace", config, unknown, replace);
      const next = { ...prior };
      for (const name of changed) next[name] = config[name];
      return planOf(changed.length ? "update" : "none", next);
    },
    async apply(ref, typeName, input) {
      const prior = parsed(input.priorStateJson);
      log("apply", ref, typeName, prior);
      const there = prior && objectWithId(typeName, prior.id);
      if (!input.configJson) {
        if (!prior) throw new BridgeError("invalid_argument", "prior_state_json or planned is required");
        if (there) delete state.objects[there[0]];
        return { errors: [], warnings: [] };
      }
      if (!input.planned?.length) throw new BridgeError("invalid_argument", "planned is required with config_json");
      if (prior && !there) {
        const summary = `${typeName} "${String(prior.id)}" no longer exists`;
        return { errors: [{ severity: "error", summary, detail: "", attributePath: "" }], warnings: [] };
      }
      const planned = JSON.parse(new TextDecoder().decode(input.planned)) as JsonObject;
      let id = prior?.id ?? planned.id;
      if (id === null || id === undefined) {
        do id = `${typeName}-${++created}`;
        while (objectWithId(typeName, id));
        const { vendorOwned = [] } = types[typeName]?.fields ?? {};
        const shape = types[typeName]?.schema?.shape ?? {};
        for (const name of topLevel(vendorOwned) as Set<string>) {
          if (planned[name] === null && shape[name]?.safeParse("").success) planned[name] = `${name}-${created}`;
        }
      }
      const object: StateObject = {
        typeName,
        state: { ...planned, id },
        private: there?.[1].private ?? "",
        schemaVersion: there?.[1].schemaVersion ?? types[typeName]?.schemaVersion ?? 0,
      };
      state.objects[there?.[0] ?? `${typeName}/${String(id)}`] = object;
      return { resource: resourceOf(object), errors: [], warnings: [] };
    },
    async configure(ref, configJson) {
      calls.push({ method: "configure", ref });
      const before = configured.get(session(ref));
      if (before !== undefined && before !== configJson) {
        throw new BridgeError(
          "failed_precondition",
          `${releaseName(ref)} is already configured with a different config; Close it first`,
        );
      }
      configured.set(session(ref), configJson);
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
      const found = objectWithId(typeName, id)?.[1];
      return found ? { resource: resourceOf(found), gone: false, warnings: [] } : { gone: true, warnings: [] };
    },
    async close(ref) {
      calls.push({ method: "close", ...(ref ? { ref } : {}) });
      if (ref) configured.delete(session(ref));
      else configured.clear();
    },
  };
}
