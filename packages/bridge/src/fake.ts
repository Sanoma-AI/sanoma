import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport, type ServiceImpl } from "@connectrpc/connect";
import { codeFromString } from "@connectrpc/connect/protocol-connect";
import { type Bridge, bridgeClient, type ProviderRef } from "./bridge.ts";
import { startBridge, type StartBridgeOptions } from "./client.ts";
import {
  type Fixture,
  isError,
  recordHint,
  releaseName,
  replyDir,
  schemaFile,
  stateId,
  toPath,
  typeDir,
} from "./fixtures.ts";
import {
  BridgeService,
  DiagnosticSchema,
  ImportResponseSchema,
  type ProviderRef as ProviderRefMessage,
  ReadResponseSchema,
} from "./gen/bridge/v1/bridge_pb.ts";
import { readPins, testdata } from "./pins.ts";
export { fixturesDir } from "./pins.ts";
import type { BridgeCall } from "./replies.ts";
import { recorder } from "./record.ts";
import { parseSchema, type SchemaDocument } from "./schema.ts";

export interface FakeBridgeOptions {
  /** The fixtures: `pins.json`, `schemas/` and `replies/`. Default: this package's `testdata/`. */
  fixtures?: string | URL;
  /** With `SANOMA_LIVE=1`, how to start the real bridge. */
  bridge?: StartBridgeOptions;
}

export {
  type BridgeCall,
  type BridgeState,
  loadReplies,
  type StateFailure,
  type StateObject,
  stateBridge,
} from "./replies.ts";

export interface FakeBridge extends Bridge {
  /** Every call, in order. */
  readonly calls: BridgeCall[];
  /** True when `SANOMA_LIVE=1`: calls go to a real bridge. */
  readonly live: boolean;
}

/**
 * A `Bridge` that answers from recorded fixtures, the format provider-bridge's `bridge-record`
 * writes, with the errors the real bridge would give: not configured, configured differently, a
 * pin mismatch, an unknown resource type. A call no fixture covers fails (`failed_precondition`
 * for a schema, `not_found` for an import or read) naming the file to record.
 *
 * `SANOMA_LIVE=1` sends the calls to a real bridge instead (`startBridge(options.bridge)`), and
 * with `SANOMA_RECORD=1` as well, rewrites the fixtures from its replies, scrubbed.
 */
export function fakeBridge(options: FakeBridgeOptions = {}): FakeBridge {
  const dir = toPath(options.fixtures ?? testdata);
  const live = process.env.SANOMA_LIVE === "1";
  const recording = live && process.env.SANOMA_RECORD === "1";
  const calls: BridgeCall[] = [];
  const inner = live ? liveBridge(dir, options.bridge ?? {}, recording) : replayBridge(dir);
  const log = (call: BridgeCall) => calls.push(call);
  return {
    calls,
    live,
    schema: (ref) => (log({ method: "schema", ref }), inner.schema(ref)),
    configure: (ref, configJson) => (log({ method: "configure", ref }), inner.configure(ref, configJson)),
    import: (ref, typeName, id) => (log({ method: "import", ref, typeName, id }), inner.import(ref, typeName, id)),
    read: (ref, typeName, stateJson, priv, schemaVersion) => {
      const id = safeStateId(stateJson);
      log({ method: "read", ref, typeName, ...(id === undefined ? {} : { id }) });
      return inner.read(ref, typeName, stateJson, priv, schemaVersion);
    },
    close: (ref) => (log({ method: "close", ...(ref ? { ref } : {}) }), inner.close(ref)),
    stop: () => inner.stop(),
  };
}

function safeStateId(stateJson: string): string | undefined {
  try {
    return stateId(stateJson);
  } catch {
    return undefined;
  }
}

/** The real bridge, started on the first call; recording, schema is fetched before configure so the recorder can scrub. */
function liveBridge(dir: string, options: StartBridgeOptions, recording: boolean): Bridge {
  let started: Promise<Bridge> | undefined;
  const bridge = () =>
    (started ??= startBridge({
      ...options,
      interceptors: [...(options.interceptors ?? []), ...(recording ? [recorder(dir)] : [])],
    }));
  return {
    schema: async (ref) => (await bridge()).schema(ref),
    configure: async (ref, configJson) => {
      const b = await bridge();
      if (recording) await b.schema(ref);
      return b.configure(ref, configJson);
    },
    import: async (ref, typeName, id) => (await bridge()).import(ref, typeName, id),
    read: async (...args) => (await bridge()).read(...args),
    close: async (ref) => {
      if (started) await (await started).close(ref);
    },
    stop: async () => {
      if (started) await (await started).stop();
    },
  };
}

function replayBridge(dir: string): Bridge {
  const transport = createRouterTransport(({ service }) => service(BridgeService, replayService(dir)));
  return bridgeClient(createClient(BridgeService, transport), async () => {});
}

const fail = (code: Code, message: string) => new ConnectError(message, code);

/** Answers from a fixture file: its response, or the error it recorded. */
function replay<T>(file: string, ok: (response: JsonValue) => T): T {
  const fixture = JSON.parse(readFileSync(file, "utf8")) as Fixture;
  const { response } = fixture;
  if (isError(response)) {
    const { code, message, diagnostics } = response.error;
    const details = diagnostics.map((d) => ({
      desc: DiagnosticSchema,
      value: fromJson(DiagnosticSchema, d as JsonValue),
    }));
    throw new ConnectError(message, codeFromString(code) ?? Code.Unknown, undefined, details);
  }
  return ok(response as JsonValue);
}

/** `BridgeService` over fixture files, so the fake goes through the same Connect client and error mapping as the real one. */
function replayService(dir: string): ServiceImpl<typeof BridgeService> {
  const pinsFile = join(dir, "pins.json");
  const pins = existsSync(pinsFile) ? readPins(pinsFile) : {};
  const schemas = new Map<string, { json: string; doc: SchemaDocument }>();
  const configured = new Map<string, string>();
  const reads = new Map<string, Map<string, string>>();
  const where = (file: string) => relative(dir, file);

  /** The request's release, checked as the bridge checks it, with its SHA256SUMS hash. */
  function release(provider: ProviderRefMessage | undefined): { ref: ProviderRef; sha256: string } {
    if (!provider?.source || !provider.version) {
      throw fail(Code.InvalidArgument, "provider source and version are required");
    }
    const { source, version } = provider;
    const pin = pins[source];
    const sha256 = pin?.version === version ? (pin.sha256 ?? "") : "";
    if (provider.sha256 && sha256 && provider.sha256 !== sha256) {
      throw fail(
        Code.FailedPrecondition,
        `refusing release: ${source} ${version}: SHA256SUMS sha256 is ${sha256}, pinned ${provider.sha256}`,
      );
    }
    return { ref: { source, version, sha256 }, sha256 };
  }

  function schemaOf(ref: ProviderRef) {
    const name = releaseName(ref);
    let schema = schemas.get(name);
    if (!schema) {
      const file = schemaFile(dir, ref);
      if (!existsSync(file)) {
        throw fail(Code.FailedPrecondition, `${name}: no recorded schema at ${where(file)}; ${recordHint}`);
      }
      const json = readFileSync(file, "utf8");
      schema = { json, doc: parseSchema(json) };
      schemas.set(name, schema);
    }
    return schema;
  }

  /** A configured release and the resource type's schema, or the bridge's error. */
  function configuredType(provider: ProviderRefMessage | undefined, typeName: string) {
    const { ref } = release(provider);
    if (!configured.has(releaseName(ref))) {
      throw fail(Code.FailedPrecondition, `${releaseName(ref)} is not configured; call Configure first`);
    }
    if (!schemaOf(ref).doc.resources[typeName]) {
      throw fail(Code.InvalidArgument, `provider has no resource type "${typeName}"`);
    }
    return ref;
  }

  /** The recorded reads of a resource type, by the `id` in their request's state. */
  function readsOf(ref: ProviderRef, typeName: string): Map<string, string> {
    const key = `${releaseName(ref)} ${typeName}`;
    let index = reads.get(key);
    if (!index) {
      index = new Map();
      const root = typeDir(dir, ref, typeName);
      const folders = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
      for (const folder of folders) {
        for (const name of readdirSync(join(root, folder.name)).filter((n) => /^read(-\d+)?\.json$/.test(n))) {
          const file = join(root, folder.name, name);
          const { request } = JSON.parse(readFileSync(file, "utf8")) as Fixture;
          const id = stateId(String(request.stateJson ?? "{}"));
          if (id !== undefined && !index.has(id)) index.set(id, file);
        }
      }
      reads.set(key, index);
    }
    return index;
  }

  return {
    getSchema(req) {
      const { ref, sha256 } = release(req.provider);
      const { json, doc } = schemaOf(ref);
      return { schemaJson: json, protocol: doc.protocol, sha256 };
    },
    configure(req) {
      const { ref, sha256 } = release(req.provider);
      schemaOf(ref);
      let config: unknown;
      try {
        config = JSON.parse(req.configJson);
      } catch (error) {
        throw fail(Code.InvalidArgument, `config_json: ${(error as Error).message}`);
      }
      if (typeof config !== "object" || config === null || Array.isArray(config)) {
        throw fail(Code.InvalidArgument, "config_json must be a JSON object");
      }
      const name = releaseName(ref);
      const canonical = JSON.stringify(config);
      const before = configured.get(name);
      if (before !== undefined && before !== canonical) {
        throw fail(Code.FailedPrecondition, `${name} is already configured with a different config; Close it first`);
      }
      configured.set(name, canonical);
      return { warnings: [], sha256 };
    },
    import(req) {
      if (!req.typeName || !req.id) throw fail(Code.InvalidArgument, "type_name and id are required");
      const ref = configuredType(req.provider, req.typeName);
      const file = join(replyDir(dir, ref, req.typeName, req.id), "import.json");
      if (!existsSync(file)) {
        throw fail(
          Code.NotFound,
          `import ${req.typeName} "${req.id}": no recorded reply at ${where(file)}; ${recordHint}`,
        );
      }
      return replay(file, (response) => fromJson(ImportResponseSchema, response));
    },
    read(req) {
      const ref = configuredType(req.provider, req.typeName);
      let id: string | undefined;
      try {
        const state = JSON.parse(req.stateJson) as unknown;
        if (typeof state !== "object" || state === null || Array.isArray(state)) throw new Error("not an object");
        id = stateId(req.stateJson);
      } catch {
        throw fail(Code.InvalidArgument, "state_json must be a JSON object");
      }
      const file = id === undefined ? undefined : readsOf(ref, req.typeName).get(id);
      if (!file) {
        const expected = join(replyDir(dir, ref, req.typeName, id ?? "<id>"), "read.json");
        throw fail(
          Code.NotFound,
          `read ${req.typeName} "${id ?? ""}": no recorded reply for a state with this id (expected at ${where(expected)}); ${recordHint}`,
        );
      }
      return replay(file, (response) => fromJson(ReadResponseSchema, response));
    },
    close(req) {
      if (req.provider?.source) configured.delete(releaseName(release(req.provider).ref));
      else configured.clear();
      return {};
    },
  };
}
