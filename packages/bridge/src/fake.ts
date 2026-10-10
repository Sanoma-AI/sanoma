import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { type DescMessage, fromJson, type JsonValue, type MessageShape } from "@bufbuild/protobuf";
import {
  Code,
  ConnectError,
  createClient,
  createRouterTransport,
  type Interceptor,
  type ServiceImpl,
} from "@connectrpc/connect";
import { codeFromString } from "@connectrpc/connect/protocol-connect";
import { type Bridge, bridgeClient, type ProviderRef } from "./bridge.ts";
import { startBridge, type StartBridgeOptions } from "./client.ts";
import {
  type Fixture,
  isError,
  recordHint,
  releaseName,
  releaseSlug,
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
import { isObject } from "./json.ts";
import { readPins, testdata } from "./pins.ts";
import { recorder } from "./record.ts";
import type { BridgeCall } from "./replies.ts";
import { parseSchema, type SchemaDocument } from "./schema.ts";

export type { FixtureError } from "./fixtures.ts";
export { fixturesDir } from "./pins.ts";
export {
  type BridgeCall,
  type BridgeState,
  loadReplies,
  type StateFailure,
  type StateObject,
  stateBridge,
} from "./replies.ts";
export { type TfFake, tfFake, type TfFakeOptions, type TfFakeState } from "./tffake.ts";

export interface FakeBridgeOptions {
  /** The fixtures: `pins.json`, `schemas/` and `replies/`. Default: this package's `testdata/`. */
  fixtures?: string | URL;
  /** With `SANOMA_LIVE=1`, how to start the real bridge. */
  bridge?: StartBridgeOptions;
}

export interface FakeBridge extends Bridge {
  /** Every call sent, in order. */
  readonly calls: BridgeCall[];
  /** True when `SANOMA_LIVE=1`: calls go to a real bridge. */
  readonly live: boolean;
}

const METHODS: Record<string, BridgeCall["method"]> = {
  GetSchema: "schema",
  Configure: "configure",
  Import: "import",
  Read: "read",
  Close: "close",
};

/** A Connect interceptor that logs each call, on the real transport and the in-memory one alike. */
function logCalls(calls: BridgeCall[]): Interceptor {
  return (next) => (req) => {
    const method = METHODS[req.method.name];
    const msg = req.message as { provider?: ProviderRefMessage; typeName?: string; id?: string; stateJson?: string };
    if (method) {
      const { source = "", version = "", sha256 = "" } = msg.provider ?? {};
      let id = msg.id || undefined;
      if (method === "read") {
        try {
          id = stateId(msg.stateJson ?? "");
        } catch {
          // Not JSON: the bridge refuses it, and the log says so by its call alone.
        }
      }
      calls.push({
        method,
        ...(source && { ref: { source, version, ...(sha256 && { sha256 }) } }),
        ...(msg.typeName && { typeName: msg.typeName }),
        ...(id !== undefined && { id }),
      });
    }
    return next(req);
  };
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
  const calls: BridgeCall[] = [];
  const bridge = live
    ? liveBridge(dir, options.bridge ?? {}, logCalls(calls), process.env.SANOMA_RECORD === "1")
    : bridgeClient(
        createClient(
          BridgeService,
          createRouterTransport(({ service }) => service(BridgeService, replayService(dir)), {
            transport: { interceptors: [logCalls(calls)] },
          }),
        ),
        async () => {},
      );
  return Object.assign(bridge, { calls, live });
}

/**
 * The real bridge, started on the first call. Recording, the schema is fetched before the first
 * configure of each release, so the recorder can scrub what the provider marks sensitive.
 */
function liveBridge(dir: string, options: StartBridgeOptions, log: Interceptor, recording: boolean): Bridge {
  let started: Promise<Bridge> | undefined;
  const bridge = () =>
    (started ??= startBridge({
      ...options,
      interceptors: [log, ...(options.interceptors ?? []), ...(recording ? [recorder(dir)] : [])],
    }));
  const schemas = new Set<string>();
  return {
    schema: async (ref) => (await bridge()).schema(ref),
    configure: async (ref, configJson) => {
      const b = await bridge();
      if (recording && !schemas.has(releaseName(ref))) {
        await b.schema(ref);
        schemas.add(releaseName(ref));
      }
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

const fail = (code: Code, message: string) => new ConnectError(message, code);

/** Answers from a fixture: its response, as a message of `schema`, or the error it recorded. */
function replay<Desc extends DescMessage>(fixture: Fixture, schema: Desc): MessageShape<Desc> {
  const { response } = fixture;
  if (isError(response)) {
    const { code, message, diagnostics } = response.error;
    const details = diagnostics.map((d) => ({
      desc: DiagnosticSchema,
      value: fromJson(DiagnosticSchema, d as JsonValue),
    }));
    throw new ConnectError(message, codeFromString(code) ?? Code.Unknown, undefined, details);
  }
  return fromJson(schema, response as JsonValue);
}

const readFixture = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Fixture;

/** Parsed schema documents by file, shared by every fake: Stripe's is 2.3 MB. A changed file is read again. */
const documents = new Map<string, { mtimeMs: number; json: string; doc: SchemaDocument }>();

function documentAt(file: string) {
  const { mtimeMs } = statSync(file);
  let entry = documents.get(file);
  if (entry?.mtimeMs !== mtimeMs) {
    const json = readFileSync(file, "utf8");
    entry = { mtimeMs, json, doc: parseSchema(json) };
    documents.set(file, entry);
  }
  return entry;
}

/** Every reply fixture of a release, for its recorded sha256. */
function* replyFiles(root: string): Generator<string> {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* replyFiles(path);
    else if (entry.name.endsWith(".json")) yield path;
  }
}

/** `BridgeService` over fixture files, so the fake goes through the same Connect client and error mapping as the real one. */
function replayService(dir: string): ServiceImpl<typeof BridgeService> {
  const pinsFile = join(dir, "pins.json");
  const pins = existsSync(pinsFile) ? readPins(pinsFile) : {};
  const recorded = new Map<string, string | undefined>();
  const configured = new Map<string, string>();
  const reads = new Map<string, Map<string, Fixture>>();
  const where = (file: string) => relative(dir, file);

  /** The release's SHA256SUMS hash: its pin, else what its recorded replies say; undefined when neither knows. */
  function sha256Of(ref: { source: string; version: string }): string | undefined {
    const pin = pins[ref.source];
    if (pin?.version === ref.version) return pin.sha256;
    const name = releaseName(ref);
    if (!recorded.has(name)) {
      const [file] = replyFiles(join(dir, "replies", releaseSlug(ref)));
      recorded.set(name, file && (readFixture(file).provider.sha256 || undefined));
    }
    return recorded.get(name);
  }

  /** The request's release, its pin checked as the bridge checks it. */
  function release(provider: ProviderRefMessage | undefined): Required<ProviderRef> {
    if (!provider?.source || !provider.version) {
      throw fail(Code.InvalidArgument, "provider source and version are required");
    }
    const { source, version } = provider;
    const sha256 = sha256Of(provider);
    if (provider.sha256 && provider.sha256 !== sha256) {
      throw fail(
        Code.FailedPrecondition,
        sha256 === undefined
          ? `refusing release: ${source} ${version}: no recorded SHA256SUMS sha256 to check the pin ${provider.sha256} against`
          : `refusing release: ${source} ${version}: SHA256SUMS sha256 is ${sha256}, pinned ${provider.sha256}`,
      );
    }
    return { source, version, sha256: sha256 ?? "" };
  }

  function schemaOf(ref: ProviderRef) {
    const file = schemaFile(dir, ref);
    if (!existsSync(file)) {
      throw fail(Code.FailedPrecondition, `${releaseName(ref)}: no recorded schema at ${where(file)}; ${recordHint}`);
    }
    return documentAt(file);
  }

  /** A configured release and the resource type's schema, or the bridge's error. */
  function configuredType(provider: ProviderRefMessage | undefined, typeName: string) {
    const ref = release(provider);
    if (!configured.has(releaseName(ref))) {
      throw fail(Code.FailedPrecondition, `${releaseName(ref)} is not configured; call Configure first`);
    }
    if (!schemaOf(ref).doc.resources[typeName]) {
      throw fail(Code.InvalidArgument, `provider has no resource type "${typeName}"`);
    }
    return ref;
  }

  /** The recorded reads of a resource type, by the `id` in their request's state. */
  function readsOf(ref: ProviderRef, typeName: string): Map<string, Fixture> {
    const key = `${releaseName(ref)} ${typeName}`;
    let index = reads.get(key);
    if (!index) {
      index = new Map();
      const root = typeDir(dir, ref, typeName);
      const folders = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
      for (const folder of folders) {
        for (const name of readdirSync(join(root, folder.name)).filter((n) => /^read(-\d+)?\.json$/.test(n))) {
          const fixture = readFixture(join(root, folder.name, name));
          const id = stateId(String(fixture.request.stateJson ?? "{}"));
          if (id !== undefined && !index.has(id)) index.set(id, fixture);
        }
      }
      reads.set(key, index);
    }
    return index;
  }

  return {
    getSchema(req) {
      const ref = release(req.provider);
      const { json, doc } = schemaOf(ref);
      return { schemaJson: json, protocol: doc.protocol, sha256: ref.sha256 };
    },
    configure(req) {
      const ref = release(req.provider);
      const file = schemaFile(dir, ref);
      if (!existsSync(file)) {
        throw fail(Code.FailedPrecondition, `${releaseName(ref)}: no recorded schema at ${where(file)}; ${recordHint}`);
      }
      let config: unknown;
      try {
        config = JSON.parse(req.configJson);
      } catch (error) {
        throw fail(Code.InvalidArgument, `config_json: ${(error as Error).message}`);
      }
      if (!isObject(config)) throw fail(Code.InvalidArgument, "config_json must be a JSON object");
      const name = releaseName(ref);
      const canonical = JSON.stringify(config);
      const before = configured.get(name);
      if (before !== undefined && before !== canonical) {
        throw fail(Code.FailedPrecondition, `${name} is already configured with a different config; Close it first`);
      }
      configured.set(name, canonical);
      return { warnings: [], sha256: ref.sha256 };
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
      return replay(readFixture(file), ImportResponseSchema);
    },
    read(req) {
      const ref = configuredType(req.provider, req.typeName);
      let state: unknown;
      try {
        state = JSON.parse(req.stateJson);
      } catch {
        // Refused below, as anything else that is not an object.
      }
      if (!isObject(state)) throw fail(Code.InvalidArgument, "state_json must be a JSON object");
      const id = stateId(state);
      const fixture = id === undefined ? undefined : readsOf(ref, req.typeName).get(id);
      if (!fixture) {
        const expected = join(replyDir(dir, ref, req.typeName, id ?? "<id>"), "read.json");
        throw fail(
          Code.NotFound,
          `read ${req.typeName} "${id ?? ""}": no recorded reply for a state with this id (expected at ${where(expected)}); ${recordHint}`,
        );
      }
      return replay(fixture, ReadResponseSchema);
    },
    close(req) {
      if (req.provider?.source) configured.delete(releaseName(release(req.provider)));
      else configured.clear();
      return {};
    },
  };
}
