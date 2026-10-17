import { Code, ConnectError, type CallOptions, type Client } from "@connectrpc/connect";
import { codeToString } from "@connectrpc/connect/protocol-connect";
import {
  type BridgeService,
  type Diagnostic as DiagnosticMessage,
  Diagnostic_Severity,
  DiagnosticSchema,
  PlanResponse_Action,
  type Resource,
} from "./gen/bridge/v1/bridge_pb.ts";
import { parseSchema, type SchemaDocument } from "./schema.ts";

/**
 * A provider release: `source` is `namespace/type` on registry.opentofu.org (or
 * `host/namespace/type` for a host the bridge allows), `version` is exact, and `sha256` pins the
 * release's SHA256SUMS file. Take refs from `readPins()`; never build one from "latest".
 */
export interface ProviderRef {
  source: string;
  version: string;
  /** Hex sha256 of the release's SHA256SUMS. When set, the bridge refuses any other release. */
  sha256?: string;
}

/** A diagnostic from the provider: warnings come back in replies, errors in a `BridgeError`. */
export interface Diagnostic {
  severity: "error" | "warning" | "unspecified";
  summary: string;
  detail: string;
  /** In the provider's terms, e.g. `settings.secret` or `rules[0].name`; empty when none. */
  attributePath: string;
}

/** One resource instance's state, as the provider wrote it. */
export interface ResourceState {
  typeName: string;
  /** JSON object of the resource type's implied type. Parse it where precision does not matter. */
  stateJson: string;
  /** Opaque provider data: pass it back unchanged to the next `read`. */
  private: Uint8Array;
  /** The resource type's schema version that wrote `stateJson`: pass it back to `read`. */
  schemaVersion: number;
}

/**
 * What a change is planned from: the prior state, as `read` or `apply` returned it (none to plan
 * a create), and the desired config, a JSON object of the resource type's implied type with
 * computed-only attributes null (none to plan a delete).
 */
export interface PlanInput {
  priorStateJson?: string;
  priorPrivate?: Uint8Array;
  /** The schema version that wrote the prior state: the provider upgrades it first, as `read` does. */
  priorSchemaVersion?: number;
  configJson?: string;
}

/** What a plan does: `replace` deletes the object and creates it again. */
export type PlanAction = "none" | "create" | "update" | "replace" | "delete";

export interface PlanResult {
  action: PlanAction;
  /** The planned state, unknown values null (listed in `unknownPaths`); empty for a delete. */
  plannedStateJson: string;
  /** Attributes known only after apply, in the provider's terms: `id`, `rules[0].name`. */
  unknownPaths: string[];
  /** The attributes whose change replaces the object: not empty exactly when `action` is `replace`. */
  requiresReplace: string[];
  /** The provider's plan, opaque: pass it to `apply` unchanged. Empty for a delete; for a replace, the new object's. */
  planned: Uint8Array;
  plannedPrivate: Uint8Array;
  warnings: Diagnostic[];
}

/**
 * What `apply` carries out: the plan's input, and its `planned` and `plannedPrivate`. A delete
 * has no config and no `planned`; a replace is two applies, the delete (prior only), then the
 * create (config and `planned`, no prior).
 */
export interface ApplyInput extends PlanInput {
  planned?: Uint8Array;
  plannedPrivate?: Uint8Array;
}

export interface ApplyResult {
  /** The new state: set whenever the provider returned an object, even with `errors`; absent after a delete. */
  resource?: ResourceState;
  /** The provider's error diagnostics: an apply that failed at the provider resolves with them. */
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

/** The provider-bridge API: one bridge process (or its fake) serving any number of providers. */
export interface Bridge {
  /** The provider's schema document (`schema.protocol` is its plugin protocol) and its release's SHA256SUMS hash. Needs no credentials. */
  schema(ref: ProviderRef): Promise<{ schema: SchemaDocument; sha256: string }>;
  /**
   * Starts and configures the provider. The same config again is a no-op; another config for the
   * same release fails (`failed_precondition`) until `close(ref)`.
   */
  configure(ref: ProviderRef, configJson: string): Promise<{ warnings: Diagnostic[] }>;
  /**
   * Imports an existing object by its provider-specific ID, then reads it. Nothing found is
   * `not_found`, but some providers (GitHub's) report a missing object as a `failed_precondition`
   * whose diagnostic says so.
   */
  import(
    ref: ProviderRef,
    typeName: string,
    id: string,
  ): Promise<{ resources: ResourceState[]; warnings: Diagnostic[] }>;
  /**
   * Refreshes one resource from the vendor. `gone` (and no `resource`) means the object no longer
   * exists. With `schemaVersion` (the one the state was written with) the provider upgrades the
   * state first; without it, `stateJson` must match the current schema.
   */
  read(
    ref: ProviderRef,
    typeName: string,
    stateJson: string,
    priv?: Uint8Array,
    schemaVersion?: number,
  ): Promise<{ resource?: ResourceState; gone: boolean; warnings: Diagnostic[] }>;
  /**
   * Plans the change that makes one resource match `configJson`. It does not refresh: plan from
   * a fresh `read`. A config the provider rejects is `invalid_argument`, a plan it fails
   * `failed_precondition`, each with diagnostics.
   */
  plan(ref: ProviderRef, typeName: string, input: PlanInput): Promise<PlanResult>;
  /**
   * Carries out a plan. The provider's errors are in `errors`, beside the state it returned, so
   * an object created before an error is not lost; a `BridgeError` means the request was refused
   * before the provider was called, or the provider process failed.
   */
  apply(ref: ProviderRef, typeName: string, input: ApplyInput): Promise<ApplyResult>;
  /** Stops one configured provider, or every one. */
  close(ref?: ProviderRef): Promise<void>;
  /** Stops the bridge and every provider it runs. */
  stop(): Promise<void>;
}

/** Connect's error codes, as the bridge's fixtures and Connect's JSON spell them. */
export type BridgeErrorCode =
  | "canceled"
  | "unknown"
  | "invalid_argument"
  | "deadline_exceeded"
  | "not_found"
  | "already_exists"
  | "permission_denied"
  | "resource_exhausted"
  | "failed_precondition"
  | "aborted"
  | "out_of_range"
  | "unimplemented"
  | "internal"
  | "unavailable"
  | "data_loss"
  | "unauthenticated";

/**
 * A failed bridge call. `code` says what kind: `invalid_argument` (bad JSON, unknown resource
 * type, config rejected), `failed_precondition` (not configured, configured differently, pin
 * mismatch, unverifiable release, an error diagnostic from the provider), `unavailable` (the
 * provider process exited, or the bridge cannot be reached: configure again) or `not_found`
 * (an import found nothing). `diagnostics` are the provider's error diagnostics.
 */
export class BridgeError extends Error {
  override name = "BridgeError";
  readonly code: BridgeErrorCode;
  readonly diagnostics: Diagnostic[];

  constructor(code: BridgeErrorCode, message: string, diagnostics: Diagnostic[] = [], options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.diagnostics = diagnostics;
  }

  /**
   * Wraps a Connect error (or anything thrown by a call) with its code and diagnostics. A
   * socket that is missing, refused or reset is `unavailable`: the bridge is not there.
   */
  static from(error: unknown): BridgeError {
    if (error instanceof BridgeError) return error;
    const connectError = ConnectError.from(error);
    const diagnostics = connectError.findDetails(DiagnosticSchema).map(toDiagnostic);
    const code = unreachable(error) ? "unavailable" : codeName(connectError.code);
    return new BridgeError(code, connectError.rawMessage, diagnostics, { cause: error });
  }
}

const codeName = (code: Code) => codeToString(code) as BridgeErrorCode;

/** Node's codes for a socket that is not there or went away. */
const UNREACHABLE = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]);

/** True when the error, or one it was caused by, is a socket that is not there or went away. */
function unreachable(error: unknown): boolean {
  for (let e = error, depth = 0; e instanceof Error && depth < 10; e = e.cause, depth++) {
    const { code } = e as { code?: unknown };
    if (typeof code === "string" && UNREACHABLE.has(code)) return true;
  }
  return false;
}

const severities = {
  [Diagnostic_Severity.ERROR]: "error",
  [Diagnostic_Severity.WARNING]: "warning",
} as const satisfies Record<number, Diagnostic["severity"]>;

export function toDiagnostic(d: DiagnosticMessage): Diagnostic {
  const severity = severities[d.severity as keyof typeof severities] ?? "unspecified";
  return { severity, summary: d.summary, detail: d.detail, attributePath: d.attributePath };
}

const toResource = (r: Resource): ResourceState => ({
  typeName: r.typeName,
  stateJson: r.stateJson,
  private: r.private,
  schemaVersion: Number(r.schemaVersion),
});

const actions = {
  [PlanResponse_Action.NONE]: "none",
  [PlanResponse_Action.CREATE]: "create",
  [PlanResponse_Action.UPDATE]: "update",
  [PlanResponse_Action.REPLACE]: "replace",
  [PlanResponse_Action.DELETE]: "delete",
} as const satisfies Record<number, PlanAction>;

/** A plan's or apply's input as the request's prior and config fields. */
const changeOf = ({ priorStateJson = "", priorPrivate, priorSchemaVersion, configJson = "" }: PlanInput) => ({
  priorStateJson,
  configJson,
  ...(priorPrivate === undefined ? {} : { priorPrivate }),
  ...(priorSchemaVersion === undefined ? {} : { priorSchemaVersion: BigInt(priorSchemaVersion) }),
});

/** Runs a call, its failure as a `BridgeError`. */
async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw BridgeError.from(error);
  }
}

const providerOf = ({ source, version, sha256 = "" }: ProviderRef) => ({ source, version, sha256 });

/**
 * A `Bridge` over a Connect client of `BridgeService`: the real client's transport is the
 * bridge's socket, the fake's is an in-memory router, so both share this mapping.
 */
export function bridgeClient(
  rpc: Client<typeof BridgeService>,
  stop: () => Promise<void>,
  options: CallOptions = {},
): Bridge {
  // A release's schema is pinned by its sha256, so it is parsed once (Stripe's is 2.3 MB).
  const schemas = new Map<string, SchemaDocument>();
  return {
    schema: (ref) =>
      call(async () => {
        const res = await rpc.getSchema({ provider: providerOf(ref) }, options);
        const key = `${ref.source} ${ref.version} ${res.sha256} ${res.schemaJson.length}`;
        let schema = schemas.get(key);
        if (!schema) schemas.set(key, (schema = parseSchema(res.schemaJson)));
        return { schema, sha256: res.sha256 };
      }),
    configure: (ref, configJson) =>
      call(async () => {
        const res = await rpc.configure({ provider: providerOf(ref), configJson }, options);
        return { warnings: res.warnings.map(toDiagnostic) };
      }),
    import: (ref, typeName, id) =>
      call(async () => {
        const res = await rpc.import({ provider: providerOf(ref), typeName, id }, options);
        return { resources: res.resources.map(toResource), warnings: res.warnings.map(toDiagnostic) };
      }),
    read: (ref, typeName, stateJson, priv, schemaVersion) =>
      call(async () => {
        const res = await rpc.read(
          {
            provider: providerOf(ref),
            typeName,
            stateJson,
            ...(priv === undefined ? {} : { private: priv }),
            ...(schemaVersion === undefined ? {} : { schemaVersion: BigInt(schemaVersion) }),
          },
          options,
        );
        return {
          ...(res.resource ? { resource: toResource(res.resource) } : {}),
          gone: res.gone,
          warnings: res.warnings.map(toDiagnostic),
        };
      }),
    plan: (ref, typeName, input) =>
      call(async () => {
        const res = await rpc.plan({ provider: providerOf(ref), typeName, ...changeOf(input) }, options);
        const action: PlanAction | undefined = actions[res.action as keyof typeof actions];
        if (!action) throw new BridgeError("internal", `plan ${typeName}: the bridge returned no action`);
        return {
          action,
          plannedStateJson: res.plannedStateJson,
          unknownPaths: res.unknownPaths,
          requiresReplace: res.requiresReplace,
          planned: res.planned,
          plannedPrivate: res.plannedPrivate,
          warnings: res.warnings.map(toDiagnostic),
        };
      }),
    apply: (ref, typeName, input) =>
      call(async () => {
        const { planned, plannedPrivate } = input;
        const res = await rpc.apply(
          {
            provider: providerOf(ref),
            typeName,
            ...changeOf(input),
            ...(planned === undefined ? {} : { planned }),
            ...(plannedPrivate === undefined ? {} : { plannedPrivate }),
          },
          options,
        );
        return {
          ...(res.resource ? { resource: toResource(res.resource) } : {}),
          errors: res.errors.map(toDiagnostic),
          warnings: res.warnings.map(toDiagnostic),
        };
      }),
    close: (ref) =>
      call(async () => {
        await rpc.close(ref ? { provider: providerOf(ref) } : {}, options);
      }),
    stop,
  };
}
