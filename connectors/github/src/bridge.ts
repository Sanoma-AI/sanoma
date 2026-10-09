// The provider bridge as this connector uses it, until `@sanoma/bridge` is merged: the
// interface the driver takes, how it recognises the bridge's errors, and a replay of recorded
// replies for the fake. This file is the swap: once `@sanoma/bridge` is in the workspace,
// these become re-exports of its `Bridge`, `ProviderRef`, `Diagnostic` and `BridgeError`, and
// `replayBridge` gives way to its `fakeBridge`. Nothing else in the connector changes.

/** Which provider release a call is for: `integrations/github` 6.13.0, pinned by the sha256 of its `SHA256SUMS`. */
export interface ProviderRef {
  source: string;
  version: string;
  sha256?: string;
}

/** A diagnostic from the provider: an error's details, or a warning in a reply. */
export interface Diagnostic {
  severity?: string | number;
  summary: string;
  detail?: string;
  attributePath?: string;
}

/** One object as the provider keeps it: its state (JSON text), private data, and the state's layout version. */
export interface BridgeResource {
  typeName: string;
  stateJson: string;
  private: Uint8Array;
  schemaVersion: number;
}

/** The calls of `@sanoma/bridge`'s `Bridge` the driver makes. A `Bridge` is one. */
export interface BridgeLike {
  configure(ref: ProviderRef, configJson: string): Promise<{ warnings: Diagnostic[] }>;
  import(
    ref: ProviderRef,
    typeName: string,
    id: string,
  ): Promise<{ resources: BridgeResource[]; warnings: Diagnostic[] }>;
  read(
    ref: ProviderRef,
    typeName: string,
    stateJson: string,
    priv?: Uint8Array,
    schemaVersion?: number,
  ): Promise<{ resource?: BridgeResource; gone: boolean; warnings: Diagnostic[] }>;
  close(ref?: ProviderRef): Promise<void>;
}

/** Connect's numeric codes the bridge uses, by name. */
const CODES: Record<number, string> = {
  3: "invalid_argument",
  4: "deadline_exceeded",
  5: "not_found",
  9: "failed_precondition",
  13: "internal",
  14: "unavailable",
};

/**
 * The bridge's error, as a code name (`failed_precondition`, `unavailable`) with its message
 * and the provider's diagnostics; undefined for anything else, such as a bug in the driver.
 */
export function bridgeErrorOf(e: unknown): { code: string; message: string; diagnostics: Diagnostic[] } | undefined {
  if (!(e instanceof Error) || (e.name !== "BridgeError" && e.name !== "ConnectError")) return undefined;
  const { code, diagnostics } = e as Error & { code?: unknown; diagnostics?: Diagnostic[] };
  const name =
    typeof code === "number"
      ? (CODES[code] ?? `code_${code}`)
      : String(code ?? "unknown")
          .replace(/([a-z])([A-Z])/g, "$1_$2")
          .toLowerCase();
  return { code: name, message: e.message, diagnostics: Array.isArray(diagnostics) ? diagnostics : [] };
}

/** One recorded object: its state as the provider returned it (parsed), its private data (base64) and layout version. */
export interface ReplayObject {
  typeName: string;
  state: Record<string, unknown>;
  private: string;
  schemaVersion: number;
}

/** A recorded failure: what the bridge answered an import with. */
export interface ReplayFailure {
  error: { code: string; message: string; diagnostics?: Diagnostic[] };
}

/** What a replay serves: objects (or failures) by `<typeName>/<import id>`. Plain JSON, so a fake can keep it in a file. */
export interface ReplayState {
  objects: Record<string, ReplayObject | ReplayFailure>;
}

/** One call a replay received, for a test to check the order the driver calls in. */
export interface ReplayCall {
  method: "configure" | "import" | "read" | "close";
  typeName?: string;
  id?: string;
}

/** Shaped as `@sanoma/bridge`'s `BridgeError`: a code name and the provider's diagnostics. */
class ReplayError extends Error {
  override name = "BridgeError";
  readonly code: string;
  readonly diagnostics: Diagnostic[];
  constructor(code: string, message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

const isFailure = (o: ReplayObject | ReplayFailure): o is ReplayFailure => "error" in o;

const resourceOf = (o: ReplayObject): BridgeResource => ({
  typeName: o.typeName,
  stateJson: JSON.stringify(o.state),
  private: Buffer.from(o.private, "base64"),
  schemaVersion: o.schemaVersion,
});

/**
 * A bridge that answers from `state`, as the provider did when the replies were recorded:
 * `import` returns the object recorded under that id (or its recorded failure, or `not_found`),
 * and `read` returns the object of that type whose `id` matches the state's, as it is in
 * `state` now, or `gone`. It reads `state` on every call, so a test can change an object
 * between calls. Every call is pushed onto `calls`.
 */
export function replayBridge(state: ReplayState, calls: ReplayCall[] = []): BridgeLike & { calls: ReplayCall[] } {
  return {
    calls,
    async configure() {
      calls.push({ method: "configure" });
      return { warnings: [] };
    },
    async import(_ref, typeName, id) {
      calls.push({ method: "import", typeName, id });
      const o = state.objects[`${typeName}/${id}`];
      if (!o) throw new ReplayError("not_found", `import ${typeName} "${id}": nothing recorded`);
      if (isFailure(o)) throw new ReplayError(o.error.code, o.error.message, o.error.diagnostics);
      return { resources: [resourceOf(o)], warnings: [] };
    },
    async read(_ref, typeName, stateJson) {
      const { id } = JSON.parse(stateJson) as { id?: unknown };
      calls.push({ method: "read", typeName, id: String(id) });
      const found = Object.values(state.objects).find(
        (o): o is ReplayObject => !isFailure(o) && o.typeName === typeName && o.state.id === id,
      );
      return found ? { resource: resourceOf(found), gone: false, warnings: [] } : { gone: true, warnings: [] };
    },
    async close() {
      calls.push({ method: "close" });
    },
  };
}
