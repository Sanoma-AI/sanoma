import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DescMessage, type MessageShape, toJson } from "@bufbuild/protobuf";
import { ConnectError, type Interceptor } from "@connectrpc/connect";
import { codeToString } from "@connectrpc/connect/protocol-connect";
import type { ProviderRef } from "../src/bridge.ts";
import { type Fixture, releaseName, releaseSlug, schemaFile, stateId } from "../src/fixtures.ts";
import {
  type ApplyRequest,
  ApplyRequestSchema,
  type ApplyResponse,
  ApplyResponseSchema,
  type ConfigureRequest,
  DiagnosticSchema,
  type GetSchemaRequest,
  type GetSchemaResponse,
  type ImportRequest,
  ImportRequestSchema,
  type ImportResponse,
  ImportResponseSchema,
  type PlanRequest,
  PlanRequestSchema,
  type PlanResponse,
  PlanResponse_Action,
  PlanResponseSchema,
  type ReadRequest,
  ReadRequestSchema,
  type ReadResponse,
  ReadResponseSchema,
} from "../src/gen/bridge/v1/bridge_pb.ts";
import { blockOf, isObject as isJsonObject, type JsonObject as Json } from "../src/json.ts";
import { type Block, parseSchema, type SchemaDocument } from "../src/schema.ts";

/** An import ID as a directory name: `repo:main` becomes `repo_main`. */
const slug = (id: string) => id.replaceAll(/[^A-Za-z0-9._-]+/g, "_");

export const typeDir = (dir: string, ref: ProviderRef, typeName: string) =>
  join(dir, "replies", releaseSlug(ref), typeName);

export const replyDir = (dir: string, ref: ProviderRef, typeName: string, id: string) =>
  join(typeDir(dir, ref, typeName), slug(id));

const canonical = (text: string) => (text ? JSON.stringify(JSON.parse(text)) : "");

/** What a plan or apply is matched by when replayed: its prior state and config, as JSON values. */
export function changeKey({ priorStateJson = "", configJson = "" }: { priorStateJson?: string; configJson?: string }) {
  return `${canonical(priorStateJson)}\n${canonical(configJson)}`;
}

/** How to (re-)record a missing fixture, for error messages. */
export const recordHint =
  "record it with SANOMA_LIVE=1 SANOMA_RECORD=1 (packages/bridge/README.md, \"Replaying and recording the bridge in this package's tests\"); the copied GitHub and Stripe fixtures come from provider-bridge's bridge-record";

/** What replaces a secret string in a recorded state. */
export const SCRUBBED = "<scrubbed>";

/** Config attributes treated as secrets even when the provider's schema does not mark them sensitive (GitHub's `token`). */
const SECRET_NAME = /token|secret|password|passphrase|api_?key|private_?key|credential|pem/i;

interface ConfigValue {
  /** `config.<path>`, as listed in a fixture's `scrubbed`. */
  name: string;
  value: string;
  /**
   * For a secret, the forms it could appear in (`encodings`): each is replaced wherever it
   * appears, and a fixture that still holds one is not written. Empty for any other value.
   */
  forms: string[];
}

interface Release {
  schema: SchemaDocument;
  sha256: string;
  config: ConfigValue[];
  /** Where the read of each imported object goes: beside its import. */
  reads: Map<string, string>;
  /** Where the apply of each planned change goes, by its type, prior state and config: beside its plan. */
  applies: Map<string, string>;
}

type Change = PlanRequest | ApplyRequest;

const applyKey = (typeName: string, priorStateJson: string, configJson: string) =>
  `${typeName}\0${priorStateJson}\0${configJson}`;

/**
 * A Connect interceptor that writes each `GetSchema`, `Import`, `Read`, `Plan` and `Apply` passing
 * through it into `dir` in provider-bridge's fixture format, scrubbed: every value of a sensitive
 * attribute, every string equal to a configure value, and every secret config value (sensitive in
 * the provider's schema, or named like a token or key) wherever it appears. `private` and
 * `planned` stay as base64; a call whose private data or plan holds a secret is refused, and so is
 * a plan or apply with a sensitive value, which its opaque `planned` would hold unscrubbed. Calls
 * need the release's schema and config first: the fake calls `schema` before `configure` when it
 * records.
 *
 * A change goes in `<type>/<slug>/`: `create-<hash>`, `<id>-<hash>` (an update), or `<id>-delete`,
 * the hash of its scrubbed prior state and config. Its `plan.json` is there, and the apply of that
 * plan beside it: `apply.json`, and for a replace `apply-delete.json` first.
 */
export function recorder(dir: string): Interceptor {
  const releases = new Map<string, Release>();
  const releaseOf = (ref: ProviderRef | undefined) => {
    const release = ref && releases.get(releaseName(ref));
    if (!ref || !release)
      throw new Error(`recording: ${ref ? releaseName(ref) : "a call"} needs schema and configure first`);
    return { ref, release };
  };

  /** Where a call goes, and its request scrubbed. Throws when the release has no schema and config yet. */
  function prepare(method: Recorded, msg: ImportRequest | ReadRequest | Change) {
    const { ref, release } = releaseOf(msg.provider);
    const hits = new Set<string>();
    if (method === "Plan" || method === "Apply") {
      const req = msg as Change;
      const scrub = (json: string) => scrubState(release, req.typeName, json, hits);
      const priorStateJson = scrub(req.priorStateJson);
      const configJson = scrub(req.configJson);
      const change = changeDir(dir, ref, req.typeName, priorStateJson, configJson);
      const file =
        method === "Plan"
          ? join(change, "plan.json")
          : (release.applies.get(applyKey(req.typeName, req.priorStateJson, req.configJson)) ??
            join(change, "apply.json"));
      const schema = method === "Plan" ? PlanRequestSchema : ApplyRequestSchema;
      const request = message(schema, { ...req, priorStateJson, configJson } as never);
      const opaque = [req.priorPrivate, ...("planned" in req ? [req.planned, req.plannedPrivate] : [])];
      return { release, hits, file, request, opaque };
    }
    if (method === "Import") {
      const req = msg as ImportRequest;
      const file = join(replyDir(dir, ref, req.typeName, req.id), "import.json");
      return { release, hits, file, request: message(ImportRequestSchema, req), opaque: [] };
    }
    const req = msg as ReadRequest;
    const request = message(ReadRequestSchema, {
      ...req,
      stateJson: scrubState(release, req.typeName, req.stateJson, hits),
    });
    return { release, hits, file: readFile(dir, ref, release, req), request, opaque: [req.private] };
  }

  /** Refuses a change the recorder could not write scrubbed before it reaches the provider, so nothing is changed unrecorded. */
  function refuseSensitive({ provider, typeName, priorStateJson, configJson }: Change) {
    const release = provider && releases.get(releaseName(provider));
    if (!release) return;
    const hits = new Set<string>();
    try {
      for (const json of [priorStateJson, configJson]) scrubState(release, typeName, json, hits);
    } catch {
      return; // Not JSON: the bridge refuses it.
    }
    const sensitive = [...hits].find((path) => path.startsWith(`${typeName}.`));
    if (sensitive) {
      throw new Error(
        `recording a change of ${typeName}: ${sensitive} is sensitive, and the plan would hold it unscrubbed; record this change with provider-bridge's bridge-record`,
      );
    }
  }

  return (next) => async (req) => {
    if (req.stream) return next(req);
    const method = req.method.name;
    if (method === "Plan" || method === "Apply") refuseSensitive(req.message as Change);
    let res: Awaited<ReturnType<typeof next>>;
    try {
      res = await next(req);
    } catch (error) {
      if (isRecorded(method)) {
        // Recorded when it can be; the caller gets the bridge's own error either way.
        try {
          const call = prepare(method, req.message as ImportRequest | ReadRequest | Change);
          write(call.file, call.release, call.request, errorJson(error), call.hits, call.opaque);
        } catch {
          // Not recordable (no schema or config yet, or a state that is not JSON).
        }
      }
      throw error;
    }
    if (res.stream) return res;

    switch (method) {
      case "GetSchema": {
        const { provider } = req.message as GetSchemaRequest;
        const { schemaJson, sha256 } = res.message as GetSchemaResponse;
        if (!provider) break;
        const known = releases.get(releaseName(provider));
        releases.set(releaseName(provider), {
          schema: parseSchema(schemaJson),
          sha256,
          config: known?.config ?? [],
          reads: known?.reads ?? new Map(),
          applies: known?.applies ?? new Map(),
        });
        writeText(schemaFile(dir, provider), schemaJson);
        break;
      }
      case "Configure": {
        const msg = req.message as ConfigureRequest;
        const { release } = releaseOf(msg.provider);
        release.config = configValues(JSON.parse(msg.configJson), release.schema.providerConfig);
        break;
      }
      case "Import": {
        const out = res.message as ImportResponse;
        const { release, hits, file, request } = prepare(method, req.message as ImportRequest);
        // The read of each imported object goes beside its import.
        const resources = out.resources.map((r, i) => {
          const id = stateId(r.stateJson);
          const read = join(dirname(file), i ? `read-${i}.json` : "read.json");
          if (id !== undefined) release.reads.set(readKey(r.typeName, id), read);
          return { ...r, stateJson: scrubState(release, r.typeName, r.stateJson, hits) };
        });
        const response = message(ImportResponseSchema, { ...out, resources });
        write(
          file,
          release,
          request,
          response,
          hits,
          out.resources.map((r) => r.private),
        );
        break;
      }
      case "Read": {
        const msg = req.message as ReadRequest;
        const out = res.message as ReadResponse;
        const { release, hits, file, request } = prepare(method, msg);
        const resource = out.resource && {
          ...out.resource,
          stateJson: scrubState(release, out.resource.typeName, out.resource.stateJson, hits),
        };
        const response = message(ReadResponseSchema, { ...out, resource });
        write(file, release, request, response, hits, [msg.private, ...(out.resource ? [out.resource.private] : [])]);
        break;
      }
      case "Plan": {
        const msg = req.message as PlanRequest;
        const out = res.message as PlanResponse;
        const call = prepare(method, msg);
        const plannedStateJson = scrubState(call.release, msg.typeName, out.plannedStateJson, call.hits);
        const response = message(PlanResponseSchema, { ...out, plannedStateJson });
        write(call.file, call.release, call.request, response, call.hits, [
          ...call.opaque,
          out.planned,
          out.plannedPrivate,
        ]);
        // Its apply goes beside it; a replace is applied as a delete, then a create.
        const at = dirname(call.file);
        const { applies } = call.release;
        applies.set(applyKey(msg.typeName, msg.priorStateJson, msg.configJson), join(at, "apply.json"));
        if (out.action === PlanResponse_Action.REPLACE) {
          applies.set(applyKey(msg.typeName, msg.priorStateJson, ""), join(at, "apply-delete.json"));
          applies.set(applyKey(msg.typeName, "", msg.configJson), join(at, "apply.json"));
        }
        break;
      }
      case "Apply": {
        const msg = req.message as ApplyRequest;
        const out = res.message as ApplyResponse;
        const call = prepare(method, msg);
        const resource = out.resource && {
          ...out.resource,
          stateJson: scrubState(call.release, out.resource.typeName, out.resource.stateJson, call.hits),
        };
        const response = message(ApplyResponseSchema, { ...out, resource });
        write(call.file, call.release, call.request, response, call.hits, [
          ...call.opaque,
          ...(out.resource ? [out.resource.private] : []),
        ]);
        break;
      }
    }
    return res;
  };
}

const readKey = (typeName: string, id: string) => `${typeName}\0${id}`;

type Recorded = "Import" | "Read" | "Plan" | "Apply";
const isRecorded = (method: string): method is Recorded => ["Import", "Read", "Plan", "Apply"].includes(method);

/** A change's directory: `create-<hash>`, `<id>-<hash>` or `<id>-delete`, from its scrubbed prior state and config. */
function changeDir(dir: string, ref: ProviderRef, typeName: string, priorStateJson: string, configJson: string) {
  const id = priorStateJson ? stateId(priorStateJson) : undefined;
  const hash = createHash("sha256").update(`${priorStateJson}\n${configJson}`).digest("hex").slice(0, 8);
  const name = id === undefined ? `create-${hash}` : configJson ? `${id}-${hash}` : `${id}-delete`;
  return replyDir(dir, ref, typeName, name);
}

function readFile(dir: string, ref: ProviderRef, release: Release, msg: ReadRequest): string {
  const id = stateId(msg.stateJson) ?? "unknown";
  return release.reads.get(readKey(msg.typeName, id)) ?? join(replyDir(dir, ref, msg.typeName, id), "read.json");
}

const message = <Desc extends DescMessage>(schema: Desc, msg: MessageShape<Desc>) =>
  toJson(schema, msg) as Record<string, unknown>;

function errorJson(error: unknown): Fixture["response"] {
  const e = ConnectError.from(error);
  const diagnostics = e
    .findDetails(DiagnosticSchema)
    .map((d) => toJson(DiagnosticSchema, d) as Record<string, unknown>);
  return { error: { code: codeToString(e.code), message: e.rawMessage, diagnostics } };
}

function write(
  file: string,
  release: Release,
  request: Record<string, unknown>,
  response: Fixture["response"],
  hits: Set<string>,
  privs: Uint8Array[] = [],
) {
  const secrets = release.config.filter((c) => c.forms.length > 0);
  for (const data of privs) {
    const text = Buffer.from(data).toString("latin1");
    const leaked = secrets.find((s) => text.includes(s.value));
    if (leaked) throw new Error(`recording ${file}: private data contains ${leaked.name}; refusing to record`);
  }
  const { source, version } = request.provider as ProviderRef;
  const fixture: Fixture = {
    provider: { source, version, sha256: release.sha256, protocol: release.schema.protocol },
    request,
    response,
    scrubbed: [...new Set([...[...hits].toSorted(), ...secrets.map((s) => s.name)])],
  };
  let text = `${JSON.stringify(fixture, null, 2)}\n`;
  for (const { name, forms } of secrets) {
    for (const form of forms) text = text.replaceAll(form, `<scrubbed:${name}>`);
  }
  const survivor = secrets.find(({ forms }) => forms.some((form) => text.includes(form)));
  if (survivor) throw new Error(`recording ${file}: ${survivor.name} survived scrubbing; refusing to write`);
  writeText(file, text);
}

function writeText(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** The forms in which a secret could appear in a fixture: raw, JSON-escaped (once and twice, as in a state inside a fixture), base64. */
function encodings(secret: string): string[] {
  const escaped = JSON.stringify(secret).slice(1, -1);
  const twice = JSON.stringify(escaped).slice(1, -1);
  const bytes = Buffer.from(secret);
  return [...new Set([secret, escaped, twice, bytes.toString("base64"), bytes.toString("base64url")])];
}

/** Every string in a configure config, flagged secret when the provider marks it sensitive or it is named like one. */
function configValues(config: unknown, block: Block): ConfigValue[] {
  const out: ConfigValue[] = [];
  const walk = (value: unknown, path: string, key: string, sensitive: boolean, schema?: Block) => {
    if (typeof value === "string" && value !== "") {
      const secret = sensitive || SECRET_NAME.test(key);
      if (secret && value.length < 8)
        throw new Error(`recording: ${path} is too short to scrub safely; refusing to record`);
      out.push({ name: path, value, forms: secret ? encodings(value) : [] });
    } else if (Array.isArray(value)) {
      for (const [i, v] of value.entries()) walk(v, `${path}[${i}]`, key, sensitive, schema);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        const attr = schema?.attributes[k];
        const nested = schema?.blocks[k]?.block ?? (attr?.nestedType && blockOf(attr.nestedType));
        walk(v, `${path}.${k}`, k, sensitive || attr?.sensitive === true, nested);
      }
    }
  };
  walk(config, "config", "", false, block);
  return out;
}

// JSON.parse with each number kept as its source text, so a scrubbed state keeps full precision.
const json = JSON as unknown as { rawJSON(text: string): object; isRawJSON(value: unknown): boolean };
const parseExact = (text: string): unknown =>
  JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === "number" && context?.source !== undefined ? json.rawJSON(context.source) : value,
  );

/** Scrubs one resource's state JSON: sensitive attributes, and strings equal to a config value. */
function scrubState(release: Release, typeName: string, stateJson: string, hits: Set<string>): string {
  const resource = release.schema.resources[typeName];
  if (!resource || stateJson === "") return stateJson;
  const state = parseExact(stateJson);
  scrubBlock(typeName, resource.block, state, hits);
  const scrubbed = scrubConfigEqual(state, release.config, hits);
  return JSON.stringify(scrubbed);
}

/** An object of a state: a number kept as its source text (`rawJSON`) is none. */
const isObject = (v: unknown): v is Json => isJsonObject(v) && !json.isRawJSON(v);

/** Calls `fn` on each object a nested block or attribute holds: a list or set's items, a map's values, or the one object. */
function eachObject(value: unknown, nesting: string, fn: (o: Json) => void) {
  if (nesting === "list" || nesting === "set") {
    if (Array.isArray(value)) for (const v of value) if (isObject(v)) fn(v);
  } else if (nesting === "map") {
    if (isObject(value)) for (const v of Object.values(value)) if (isObject(v)) fn(v);
  } else if (isObject(value)) {
    fn(value);
  }
}

function scrubBlock(prefix: string, block: Block, value: unknown, hits: Set<string>) {
  if (!isObject(value)) return;
  for (const [name, attr] of Object.entries(block.attributes)) {
    const path = `${prefix}.${name}`;
    if (value[name] === null || value[name] === undefined) continue;
    if (attr.sensitive) {
      value[name] = scrubLeaves(value[name]);
      hits.add(path);
    } else if (attr.nestedType) {
      const nested = blockOf(attr.nestedType);
      eachObject(value[name], attr.nestedType.nesting, (o) => scrubBlock(path, nested, o, hits));
    }
  }
  for (const [name, nested] of Object.entries(block.blocks)) {
    eachObject(value[name], nested.nesting, (o) => scrubBlock(`${prefix}.${name}`, nested.block, o, hits));
  }
}

/** Every string in `value` becomes `<scrubbed>`; numbers, booleans and nulls stay, so the state keeps its type. */
function scrubLeaves(value: unknown): unknown {
  if (typeof value === "string") return SCRUBBED;
  if (Array.isArray(value)) return value.map(scrubLeaves);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubLeaves(v)]));
  return value;
}

function scrubConfigEqual(value: unknown, config: ConfigValue[], hits: Set<string>): unknown {
  if (typeof value === "string") {
    const match = config.find((c) => c.value === value);
    if (!match) return value;
    hits.add(match.name);
    return SCRUBBED;
  }
  if (Array.isArray(value)) return value.map((v) => scrubConfigEqual(v, config, hits));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubConfigEqual(v, config, hits)]));
  }
  return value;
}
