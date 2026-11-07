import { DEPLOYMENT_KEYS, type DeploymentKeyName, deploymentKey } from "./deployment-key.ts";
import type { Db } from "./db.ts";
/** Opaque values belong only in trusted runtime code, never workflow history or descriptions. */
export interface SecretValue {
  value: string;
  version: string;
  updatedBy?: string;
  updatedAt?: string;
}

/** A store instance already authenticates as one deployment. A namespace is not tenant authorization. */
export interface SecretAddress {
  namespace: string;
  path: string;
}

export interface SecretStoreCapabilities {
  writable: boolean;
  /** UTF-8 bytes, including any serialized credential bundle. */
  maxBytes: number;
  /** `coordinated` covers cooperating Sanoma writers only; `none` cannot ensure or replace safely. */
  conditionalWrites: "atomic" | "coordinated" | "none";
  deletion: "destroy" | "soft-delete" | "unsupported";
  changeDetection: "read" | "watch";
}

export type SecretStoreErrorCode =
  | "invalid_configuration"
  | "unavailable"
  | "denied"
  | "conflict"
  | "read_only"
  | "unsupported"
  | "too_large"
  | "invalid_value";

/** Intentionally carries no provider message, cause, path or value. */
export class SecretStoreError extends Error {
  readonly code: SecretStoreErrorCode;
  readonly retryable: boolean;
  constructor(code: SecretStoreErrorCode) {
    super(`Secret store: ${code}`);
    this.name = "SecretStoreError";
    this.code = code;
    this.retryable = code === "unavailable";
  }
}

export interface SecretStore {
  /** Non-secret adapter identifier, e.g. `postgres` or `aws-secrets-manager`. */
  readonly id: string;
  readonly capabilities: Readonly<SecretStoreCapabilities>;
  /** Check scoped access without listing an account or returning secret material. */
  validate(namespace: string): Promise<void>;
  read(address: SecretAddress): Promise<SecretValue | undefined>;
  /** null means create only. A string means replace only that exact current version. */
  write(
    address: SecretAddress,
    value: string,
    options: { expectedVersion: string | null; by: string },
  ): Promise<SecretValue>;
  /** Delete only the exact version; report the retention behavior advertised in capabilities. */
  delete(address: SecretAddress, options: { expectedVersion: string; by: string }): Promise<void>;
}

/** Bind a fresh adapter to each runtime's existing database; create must perform no I/O or allocate owned clients. */
export interface SecretStoreFactory {
  readonly kind: "runtime";
  readonly id: string;
  readonly capabilities: Readonly<SecretStoreCapabilities>;
  /** The runtime owns this connection. Never close it or retain it outside the returned adapter. */
  create(context: { database: () => Promise<Db> }): SecretStore & {
    /** Close only clients this adapter opens lazily; never the supplied database. */
    close?(): Promise<void>;
  };
}

export const isSecretStoreFactory = (store: SecretStore | SecretStoreFactory): store is SecretStoreFactory =>
  "kind" in store && store.kind === "runtime";

export type SecretBinding =
  | { path: string; management: "sanoma" | "external"; env?: never; bootstrap?: never; host?: never }
  | {
      env: string;
      /** Deliver this binding to declared deriving hosts under its environment name. */
      host?: boolean;
      management?: "external";
      path?: never;
      bootstrap?: never;
    }
  | { bootstrap: DeploymentKeyName; management?: "external"; env?: never; path?: never; host?: never };

/** A store and namespace, as `SecretConfiguration` selects one: the built-in store when `store` is omitted, `default` without `namespace`. */
export interface SecretStoreEntry {
  store?: SecretStore | SecretStoreFactory;
  namespace?: string;
}

export interface SecretConfiguration extends SecretStoreEntry {
  /** Names without a binding resolve to the same name in this namespace. */
  bindings?: Readonly<Record<string, SecretBinding>>;
  /**
   * Other stores this deployment reaches, by a name of yours: a move's destination before its
   * cutover, the store it left after, until its copies are retired. Never read or written but by
   * a move (`migrate-store`); the runtime reads and writes the selected store alone.
   */
  stores?: Readonly<Record<string, SecretStoreEntry>>;
}

export interface SecretLocation {
  store: string;
  namespace: string;
  path: string;
  management: "sanoma" | "external";
}

const errorCodes = new Set<string>([
  "invalid_configuration",
  "unavailable",
  "denied",
  "conflict",
  "read_only",
  "unsupported",
  "too_large",
  "invalid_value",
]);
/** A store's error by its name and code, from any copy of this package. */
export const storeError = (error: unknown): error is SecretStoreError =>
  typeof error === "object" &&
  error !== null &&
  (error as SecretStoreError).name === "SecretStoreError" &&
  errorCodes.has((error as SecretStoreError).code);

/** Provider failures are sanitized even when an SDK throws a credential-bearing response. */
export async function secretStoreCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (storeError(error)) throw new SecretStoreError(error.code);
    throw new SecretStoreError("unavailable");
  }
}

const namePattern = /^[A-Z][A-Z0-9_]*$/;
const environmentPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && !value.includes("\0");

/** Structural validation only: no secret reads, provider calls or environment access. */
const invalid = () => {
  throw new SecretStoreError("invalid_configuration");
};
/** A store's id, and a name in `secrets.stores`. */
export const STORE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
function checkStoreEntry(entry: SecretStoreEntry): void {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid();
  if (entry.namespace !== undefined && !nonempty(entry.namespace)) invalid();
  if (entry.store === undefined) return;
  const s = entry.store;
  const c = s?.capabilities;
  if (
    !nonempty(s?.id) ||
    !STORE_NAME.test(s.id) ||
    !c ||
    typeof c.writable !== "boolean" ||
    !Number.isSafeInteger(c.maxBytes) ||
    c.maxBytes < 1 ||
    !["atomic", "coordinated", "none"].includes(c.conditionalWrites) ||
    !["destroy", "soft-delete", "unsupported"].includes(c.deletion) ||
    !["read", "watch"].includes(c.changeDetection) ||
    (isSecretStoreFactory(s)
      ? typeof s.create !== "function"
      : [s.validate, s.read, s.write, s.delete].some((fn) => typeof fn !== "function"))
  )
    invalid();
}
export function checkSecretConfiguration(config: SecretConfiguration): void {
  if (!config || typeof config !== "object" || Array.isArray(config)) invalid();
  checkStoreEntry(config);
  if (config.stores !== undefined) {
    if (!config.stores || typeof config.stores !== "object" || Array.isArray(config.stores)) invalid();
    for (const [name, entry] of Object.entries(config.stores)) {
      if (!STORE_NAME.test(name)) invalid();
      checkStoreEntry(entry);
    }
  }
  if (
    config.bindings !== undefined &&
    (!config.bindings || typeof config.bindings !== "object" || Array.isArray(config.bindings))
  )
    invalid();
  const hostEnvironment = new Set<string>();
  for (const [name, b] of Object.entries(config.bindings ?? {})) {
    if (!namePattern.test(name) || !b || typeof b !== "object") invalid();
    if (b.host !== undefined && (typeof b.env !== "string" || typeof b.host !== "boolean")) invalid();
    if (DEPLOYMENT_KEYS.includes(name) && !("env" in b) && !("bootstrap" in b)) invalid();
    if ("bootstrap" in b) {
      if (
        !DEPLOYMENT_KEYS.includes(b.bootstrap!) ||
        b.path !== undefined ||
        b.env !== undefined ||
        (b.management !== undefined && b.management !== "external")
      )
        invalid();
    } else if ("env" in b) {
      if (
        typeof b.env !== "string" ||
        !environmentPattern.test(b.env) ||
        b.path !== undefined ||
        (b.management !== undefined && b.management !== "external")
      )
        invalid();
      if (b.host) {
        if (hostEnvironment.has(b.env!)) invalid();
        hostEnvironment.add(b.env!);
      }
    } else if (!nonempty(b.path) || !["sanoma", "external"].includes(b.management)) invalid();
  }
}

/** Enforces binding ownership before calling a provider; preserves the drivers' get/ensure interface. */
export class SecretAccess {
  readonly store: SecretStore;
  readonly namespace: string;
  private readonly bindings: Readonly<Record<string, SecretBinding>>;

  private readonly env: (name: string) => string | undefined;
  private closing?: Promise<void>;
  private readonly onClose?: () => Promise<void>;

  constructor(
    config: SecretConfiguration,
    defaultStore: SecretStore,
    env: (name: string) => string | undefined = (name) => process.env[name],
    onClose?: () => Promise<void>,
  ) {
    this.env = env;
    this.onClose = onClose;
    checkSecretConfiguration(config);
    const store = config.store ?? defaultStore;
    if (isSecretStoreFactory(store)) throw new SecretStoreError("invalid_configuration");
    this.store = store;
    checkSecretConfiguration({ store: this.store });
    this.namespace = config.namespace ?? "default";
    this.bindings = Object.fromEntries(
      Object.entries(config.bindings ?? {}).map(([name, binding]) => [name, { ...binding }]),
    );
  }

  /** Only runtime-factory adapters are owned here; configured standalone stores remain caller-owned. */
  close(): Promise<void> {
    return (this.closing ??= secretStoreCall(async () => {
      await this.onClose?.();
    }));
  }

  location(name: string): SecretLocation {
    if (!namePattern.test(name)) throw new SecretStoreError("invalid_configuration");
    const binding = Object.hasOwn(this.bindings, name) ? this.bindings[name] : undefined;
    if (binding?.bootstrap !== undefined)
      return { store: "bootstrap", namespace: "", path: binding.bootstrap, management: "external" };
    if (DEPLOYMENT_KEYS.includes(name) && !binding) throw new SecretStoreError("invalid_configuration");
    if (binding?.env !== undefined)
      return { store: "environment", namespace: "", path: binding.env, management: "external" };
    return {
      store: this.store.id,
      namespace: this.namespace,
      path: binding?.path ?? name,
      management: binding?.management ?? "sanoma",
    };
  }

  async validate(): Promise<void> {
    await secretStoreCall(() => this.store.validate(this.namespace));
  }

  async read(name: string): Promise<SecretValue | undefined> {
    const location = this.location(name);
    if (location.store === "bootstrap" && location.namespace === "") {
      const value = deploymentKey(location.path as DeploymentKeyName).toString("base64");
      return { value, version: "bootstrap" };
    }
    if (location.store === "environment" && location.namespace === "") {
      const value = this.env(location.path);
      // No content-derived version (which would expose a hash of a low-entropy password).
      return value === undefined ? undefined : { value, version: "environment" };
    }
    return secretStoreCall(() => this.store.read(location));
  }

  async get(name: string): Promise<string | undefined> {
    return (await this.read(name))?.value;
  }

  async write(
    name: string,
    value: string,
    options: { expectedVersion: string | null; by: string },
  ): Promise<SecretValue> {
    const location = this.writable(name);
    if (Buffer.byteLength(value, "utf8") > this.store.capabilities.maxBytes) throw new SecretStoreError("too_large");
    return secretStoreCall(() => this.store.write(location, value, options));
  }

  /** Deletes the value at `expectedVersion`; without one, the value stored now, and none stored is nothing to do. */
  async delete(name: string, options: { expectedVersion?: string; by?: string } = {}): Promise<void> {
    const location = this.writable(name);
    if (this.store.capabilities.deletion === "unsupported") throw new SecretStoreError("unsupported");
    const expectedVersion = options.expectedVersion ?? (await this.read(name))?.version;
    if (expectedVersion === undefined) return;
    const by = options.by ?? "sanoma";
    await secretStoreCall(() => this.store.delete(location, { expectedVersion, by }));
  }

  async ensure(name: string, make: () => string): Promise<string> {
    const stored = await this.read(name);
    if (stored) return stored.value;
    this.writable(name);
    try {
      return (await this.write(name, make(), { expectedVersion: null, by: "sanoma" })).value;
    } catch (error) {
      if (!storeError(error) || error.code !== "conflict") throw error;
      const winner = await this.read(name);
      if (winner) return winner.value;
      throw error;
    }
  }

  private writable(name: string): SecretLocation {
    const location = this.location(name);
    if (location.management === "external" || !this.store.capabilities.writable)
      throw new SecretStoreError("read_only");
    if (this.store.capabilities.conditionalWrites === "none") throw new SecretStoreError("unsupported");
    return location;
  }
}

/** Reference provider for tests. `atomic` is scoped to this shared in-process instance only. */
const key = (a: SecretAddress) => JSON.stringify([a.namespace, a.path]);
export function memorySecretStore(
  options: { maxBytes?: number; writable?: boolean; deletion?: "destroy" | "soft-delete" } = {},
): SecretStore {
  const values = new Map<string, SecretValue>();
  const retained = new Map<string, SecretValue>();
  let generation = 0;
  const capabilities: SecretStoreCapabilities = {
    writable: options.writable ?? true,
    maxBytes: options.maxBytes ?? 65_536,
    conditionalWrites: "atomic",
    deletion: options.deletion ?? "destroy",
    changeDetection: "read",
  };
  const mutable = () => {
    if (!capabilities.writable) throw new SecretStoreError("read_only");
  };
  return {
    id: "memory",
    capabilities: Object.freeze(capabilities),
    async validate(namespace) {
      if (!nonempty(namespace)) throw new SecretStoreError("invalid_configuration");
    },
    async read(address) {
      const value = values.get(key(address));
      return value && { ...value };
    },
    async write(address, value, { expectedVersion, by }) {
      mutable();
      if (Buffer.byteLength(value, "utf8") > capabilities.maxBytes) throw new SecretStoreError("too_large");
      const current = values.get(key(address));
      if ((current?.version ?? null) !== expectedVersion) throw new SecretStoreError("conflict");
      const stored = { value, version: String(++generation), updatedBy: by, updatedAt: new Date().toISOString() };
      values.set(key(address), stored);
      return { ...stored };
    },
    async delete(address, { expectedVersion }) {
      mutable();
      if (values.get(key(address))?.version !== expectedVersion) throw new SecretStoreError("conflict");
      if (capabilities.deletion === "soft-delete") retained.set(expectedVersion, values.get(key(address))!);
      values.delete(key(address));
    },
  };
}
