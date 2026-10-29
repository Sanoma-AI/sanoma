import type { Principal } from "./define.ts";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  checkAuthenticationStore,
  decodeCredentials,
  defineAuthentication,
  type Authentication,
  type AuthenticationIdentity,
  type CallAuthentication,
} from "./authentication.ts";
import { type Connector, setupOf, VENDOR, defineConnector, defineDriver, type CallContext } from "./op.ts";
import { isSecret, type Secret } from "./secret.ts";
import { SanomaError } from "./errors.ts";
import { SecretStoreError, type SecretAccess } from "./secret-store.ts";
import type { Db } from "./db.ts";

/** Serializable account reference; vendor literal prevents cross-connector selection in typed calls. */
export interface ConnectionRef<V extends string = string> {
  readonly $connection: string;
  readonly vendor: V;
  readonly revision?: string;
}
export interface ConnectionDefinition<V extends string = string> extends ConnectionRef<V> {
  readonly name: string;
  readonly method: string;
  readonly credentials?: Secret;
  readonly scopes: readonly string[];
  readonly account?: string;
  readonly default: boolean;
}
export interface ConnectionRule<V extends string = string> {
  readonly name: string;
  readonly vendor: V;
  readonly method: string;
  readonly createBy: readonly (string | { readonly group: string })[];
  readonly scopes: readonly string[];
}
export interface ConnectionSnapshot {
  id: string;
  vendor: string;
  method: string;
  account: string;
  scopes: string[];
  revision: string;
  definition: string;
  /** A logical reference only, never the value or a provider credential. */
  credentials?: Secret;
}
const idPart = /^[a-z][a-z0-9-]{0,63}$/;
function refuse(message: string): never {
  throw new SanomaError("invalid_input", message);
}
export const connectionRefSchema = z.object({
  $connection: z.string().min(1),
  vendor: z.string().min(1),
  revision: z.string().optional(),
});
const snapshotSchema = z.object({
  id: z.string(),
  vendor: z.string(),
  method: z.string(),
  account: z.string(),
  scopes: z.array(z.string()),
  revision: z.string(),
  definition: z.string(),
  credentials: z.object({ $secret: z.string() }).optional(),
});

export function defineConnection<C extends Connector<any, any>>(
  connector: C,
  options: {
    name: string;
    method: string;
    credentials?: Secret;
    scopes?: readonly string[];
    account?: string;
    default?: boolean;
  },
): ConnectionDefinition<C[typeof VENDOR]["id"]> {
  if (!idPart.test(options.name)) refuse("A connection needs a stable lowercase name");
  const vendor = connector[VENDOR].id;
  const auth = setupOf(connector).authentication?.[options.method];
  if (!auth) refuse("The connector does not declare this authentication method");
  if (auth.kind === "workload-identity" ? options.credentials !== undefined : !isSecret(options.credentials))
    refuse("Credentials must match the authentication method");
  return Object.freeze({
    $connection: `${vendor}/${options.name}`,
    vendor,
    name: options.name,
    method: options.method,
    ...(options.credentials && { credentials: Object.freeze({ $secret: options.credentials.$secret }) }),
    scopes: Object.freeze([...(options.scopes ?? [])]),
    ...(options.account && { account: options.account }),
    default: options.default ?? false,
  });
}

export function defineConnectionRule<C extends Connector<any, any>>(
  connector: C,
  options: {
    name: string;
    method: string;
    createBy: readonly (string | { readonly group: string })[];
    scopes?: readonly string[];
  },
): ConnectionRule<C[typeof VENDOR]["id"]> {
  if (
    !idPart.test(options.name) ||
    !options.createBy.length ||
    options.createBy.some((x) =>
      typeof x === "string" ? !x.trim() : !x || typeof x.group !== "string" || !x.group.trim(),
    )
  )
    refuse("A connection rule needs a name and allowed creators");
  if (!setupOf(connector).authentication?.[options.method])
    refuse("The connector does not declare this authentication method");
  return Object.freeze({
    name: options.name,
    vendor: connector[VENDOR].id,
    method: options.method,
    createBy: Object.freeze(options.createBy.map((x) => (typeof x === "string" ? x : Object.freeze({ ...x })))),
    scopes: Object.freeze([...(options.scopes ?? [])]),
  });
}

/** Reconstitutes a dynamic reference; authority is checked from the persisted record on every call. */
export function connectionRef<V extends string>(rule: ConnectionRule<V>, id: string): ConnectionRef<V> {
  if (!id.startsWith(`${rule.vendor}/${rule.name}/`)) refuse("The connection is outside this rule");
  return Object.freeze({ $connection: id, vendor: rule.vendor });
}

export interface ConnectionCatalog {
  definitions: ReadonlyMap<string, ConnectionDefinition>;
  rules: ReadonlyMap<string, ConnectionRule>;
  methods: ReadonlyMap<string, Readonly<Record<string, Authentication>>>;
}
export function connectionCatalog(
  connectors: readonly Connector<any, any>[],
  definitions: readonly ConnectionDefinition[] = [],
  rules: readonly ConnectionRule[] = [],
): ConnectionCatalog {
  const methods = new Map<string, Record<string, Authentication>>();
  for (const connector of connectors) {
    const vendor = connector[VENDOR].id;
    const entries = methods.get(vendor) ?? {};
    for (const [name, method] of Object.entries(setupOf(connector).authentication ?? {})) {
      if (entries[name] && entries[name] !== method) refuse("Conflicting authentication methods for a connector");
      defineAuthentication(method);
      entries[name] = method;
    }
    methods.set(vendor, entries);
  }
  const defined = new Map<string, ConnectionDefinition>();
  const defaults = new Set<string>();
  for (const d of definitions) {
    if (
      !d ||
      !idPart.test(d.name) ||
      d.$connection !== `${d.vendor}/${d.name}` ||
      !methods.get(d.vendor)?.[d.method] ||
      defined.has(d.$connection)
    )
      refuse("Invalid or duplicate connection declaration");
    const auth = methods.get(d.vendor)![d.method]!;
    if (auth.kind === "workload-identity" ? d.credentials !== undefined : !isSecret(d.credentials))
      refuse("Credentials must match the authentication method");
    if (d.default && defaults.has(d.vendor)) refuse("A connector can have only one explicit default connection");
    if (d.default) defaults.add(d.vendor);
    defined.set(d.$connection, d);
  }
  const dynamic = new Map<string, ConnectionRule>();
  for (const r of rules) {
    const id = `${r.vendor}/${r.name}`;
    if (
      !idPart.test(r.name) ||
      !methods.get(r.vendor)?.[r.method] ||
      dynamic.has(id) ||
      defined.has(id) ||
      !r.createBy.length
    )
      refuse("Invalid or duplicate connection rule");
    dynamic.set(id, r);
  }
  return { definitions: defined, rules: dynamic, methods };
}

type ConnectionRow = {
  id: string;
  vendor: string;
  method: string;
  owner: string | null;
  rule: string | null;
  account: string;
  scopes: string[];
  revision: string;
  definition: string;
  credential: string | null;
  status: "connected" | "disconnected";
};
const snapshot = (r: ConnectionRow): ConnectionSnapshot => ({
  id: r.id,
  vendor: r.vendor,
  method: r.method,
  account: r.account,
  scopes: r.scopes,
  revision: r.revision,
  definition: r.definition,
  ...(r.credential && { credentials: { $secret: r.credential } }),
});
const fingerprint = (declaration: ConnectionDefinition | ConnectionRule, method: Authentication): string =>
  createHash("sha256")
    .update(JSON.stringify({ declaration, kind: method.kind, version: method.version, storage: method.storage }))
    .digest("hex");

/** Persists account metadata only. Secret values are handled outside these operations. */
export class ConnectionRegistry {
  readonly catalog: ConnectionCatalog;
  private readonly db: () => Promise<Db>;
  private readonly secrets?: SecretAccess;
  constructor(catalog: ConnectionCatalog, db: () => Promise<Db>, secrets?: SecretAccess) {
    this.catalog = catalog;
    this.db = db;
    this.secrets = secrets;
  }

  /** A direct metadata write uses the same transaction as its default ledger record. */
  onDatabase(db: Db): ConnectionRegistry {
    return new ConnectionRegistry(this.catalog, async () => db, this.secrets);
  }

  private bindingFingerprint(
    declaration: ConnectionDefinition | ConnectionRule,
    method: Authentication,
    credential?: string | null,
  ): string {
    const name = credential ?? ("credentials" in declaration ? declaration.credentials?.$secret : undefined);
    const location = name ? this.secrets?.location(name) : undefined;
    return createHash("sha256")
      .update(JSON.stringify({ contract: fingerprint(declaration, method), location }))
      .digest("hex");
  }

  private checkStore(method: Authentication, credential?: string | null): void {
    if (!this.secrets || !credential) return;
    const location = this.secrets.location(credential);
    const caps =
      location.namespace === ""
        ? {
            writable: false,
            maxBytes: Number.MAX_SAFE_INTEGER,
            conditionalWrites: "none" as const,
            deletion: "unsupported" as const,
            changeDetection: "read" as const,
          }
        : this.secrets.store.capabilities;
    checkAuthenticationStore(method, caps, location.management);
  }

  private async row(id: string): Promise<ConnectionRow | undefined> {
    return (await (await this.db()).query<ConnectionRow>("SELECT * FROM sanoma_connections WHERE id=$1", [id])).rows[0];
  }

  async select(vendor: string, ref: ConnectionRef | undefined, actor: string): Promise<ConnectionSnapshot | undefined> {
    if (!ref) {
      const defaults = [...this.catalog.definitions.values()].filter((d) => d.vendor === vendor && d.default);
      if (defaults[0]) ref = defaults[0];
      else if (
        Object.keys(this.catalog.methods.get(vendor) ?? {}).length ||
        [...this.catalog.definitions.values()].some((d) => d.vendor === vendor)
      )
        refuse("Select a named connection or declare an explicit default");
      else return undefined; // Operations without an authentication method need no connection.
    }
    if (!ref || ref.vendor !== vendor) refuse("The selected connection belongs to another connector");
    const row = await this.row(ref.$connection);
    if (!row || row.vendor !== vendor || row.status !== "connected")
      refuse("The connection is missing or disconnected");
    if (ref.revision !== undefined && ref.revision !== row.revision)
      refuse("The connection changed after authorization; start a new call");
    const declaration = row.rule ? this.catalog.rules.get(row.rule) : this.catalog.definitions.get(row.id);
    if (!declaration || declaration.vendor !== vendor || declaration.method !== row.method)
      refuse("The connection is not declared");
    if (row.rule && row.owner !== actor)
      throw new SanomaError("policy_denied", "The connection belongs to another principal");
    const method = this.catalog.methods.get(vendor)?.[row.method];
    if (!method || row.definition !== this.bindingFingerprint(declaration, method, row.credential))
      refuse("The connection declaration changed; reconnect before use");
    this.checkStore(method, row.credential);
    return snapshot(row);
  }

  async assertCurrent(selected: ConnectionSnapshot | undefined, actor: string): Promise<void> {
    if (!selected) return;
    const current = await this.select(selected.vendor, { vendor: selected.vendor, $connection: selected.id }, actor);
    if (
      !current ||
      current.revision !== selected.revision ||
      current.definition !== selected.definition ||
      current.method !== selected.method ||
      current.account !== selected.account ||
      current.credentials?.$secret !== selected.credentials?.$secret ||
      JSON.stringify(current.scopes.toSorted()) !== JSON.stringify(selected.scopes.toSorted())
    )
      refuse("The connection changed after authorization; start a new call");
  }

  /** Only called inside an authorized driver boundary. No value escapes into workflow history. */
  async authenticate(selected: ConnectionSnapshot, actor: string): Promise<CallAuthentication> {
    await this.assertCurrent(selected, actor);
    const method = this.catalog.methods.get(selected.vendor)?.[selected.method];
    if (!method?.verify) throw new SecretStoreError("unsupported");
    const material: CallAuthentication = { method: selected.method, kind: method.kind };
    let identity: AuthenticationIdentity;
    if (method.kind !== "workload-identity") {
      if (!this.secrets || !selected.credentials) throw new SecretStoreError("unavailable");
      const bundle = await this.secrets.read(selected.credentials.$secret);
      if (!bundle) throw new SecretStoreError("unavailable");
      material.credentials = decodeCredentials(method, bundle.value);
      material.credentialVersion = bundle.version;
    }
    // Verifiers may throw SDK errors containing headers or values. Keep none of their details.
    try {
      identity = await method.verify(material.credentials);
      if (
        identity.account !== selected.account ||
        !Array.isArray(identity.scopes) ||
        identity.scopes.some((scope) => typeof scope !== "string") ||
        JSON.stringify([...new Set(identity.scopes)].toSorted()) !==
          JSON.stringify([...new Set(selected.scopes)].toSorted()) ||
        (identity.expiresAt !== undefined && (!Number.isFinite(identity.expiresAt) || identity.expiresAt <= Date.now()))
      )
        throw new Error();
    } catch {
      throw new SecretStoreError("denied");
    }
    // A disconnect or rebind while verification was in flight revokes this invocation too.
    await this.assertCurrent(selected, actor);
    return material;
  }

  async bind(
    ref: ConnectionRef,
    account: string,
    scopes: string[],
    expectedRevision: string | null,
    actor: string,
  ): Promise<ConnectionSnapshot> {
    const declaration = this.catalog.definitions.get(ref.$connection);
    if (!declaration || declaration.vendor !== ref.vendor) refuse("The connection is not declared");
    if (declaration.account && account !== declaration.account)
      refuse("The account does not match the connection requirement");
    if (declaration.scopes.some((s) => !scopes.includes(s))) refuse("The account has not granted the required scopes");
    const method = this.catalog.methods.get(ref.vendor)![declaration.method]!;
    const row: ConnectionRow = {
      id: ref.$connection,
      vendor: ref.vendor,
      method: declaration.method,
      owner: null,
      rule: null,
      account,
      scopes,
      revision: randomUUID(),
      definition: this.bindingFingerprint(declaration, method),
      credential: declaration.credentials?.$secret ?? null,
      status: "connected",
    };
    this.checkStore(method, row.credential);
    await this.save(row, expectedRevision, actor);
    return snapshot(row);
  }

  async create(
    ruleId: string,
    account: string,
    scopes: string[],
    actor: Principal | string,
  ): Promise<ConnectionSnapshot> {
    const rule = this.catalog.rules.get(ruleId);
    const person = typeof actor === "string" ? { id: actor } : actor;
    if (
      !rule ||
      !rule.createBy.some((by) => (typeof by === "string" ? by === person.id : person.groups?.includes(by.group)))
    )
      throw new SanomaError("policy_denied", "This principal cannot create connections under this rule");
    if (rule.scopes.some((s) => !scopes.includes(s))) refuse("The account has not granted the required scopes");
    const method = this.catalog.methods.get(rule.vendor)![rule.method]!;
    const id = `${ruleId}/${randomUUID()}`;
    const credential =
      method.kind === "workload-identity" ? null : `CONNECTION_${randomUUID().replaceAll("-", "").toUpperCase()}`;
    const row: ConnectionRow = {
      id,
      vendor: rule.vendor,
      method: rule.method,
      owner: person.id,
      rule: ruleId,
      account,
      scopes,
      revision: randomUUID(),
      definition: this.bindingFingerprint(rule, method, credential),
      credential,
      status: "connected",
    };
    this.checkStore(method, row.credential);
    await this.save(row, null, person.id);
    return snapshot(row);
  }

  async disconnect(
    ref: ConnectionRef,
    expectedRevision: string,
    actor: string,
  ): Promise<{ id: string; revision: string; status: "disconnected" }> {
    const row = await this.row(ref.$connection);
    if (
      !row ||
      row.vendor !== ref.vendor ||
      (row.rule ? !this.catalog.rules.has(row.rule) : !this.catalog.definitions.has(row.id))
    )
      refuse("The connection is not declared");
    if (row.rule && row.owner !== actor)
      throw new SanomaError("policy_denied", "The connection belongs to another principal");
    const revision = randomUUID();
    const changed = await (
      await this.db()
    ).query(
      "UPDATE sanoma_connections SET status='disconnected',revision=$2,updated_by=$3,updated_at=now() WHERE id=$1 AND revision=$4 RETURNING id",
      [row.id, revision, actor, expectedRevision],
    );
    if (!changed.rowCount) refuse("The connection changed; reload before disconnecting it");
    return { id: row.id, revision, status: "disconnected" };
  }

  private async save(row: ConnectionRow, expected: string | null, actor: string): Promise<void> {
    const values = [
      row.id,
      row.vendor,
      row.method,
      row.owner,
      row.rule,
      row.account,
      JSON.stringify(row.scopes),
      row.revision,
      row.definition,
      row.credential,
      actor,
    ];
    const query =
      expected === null
        ? "INSERT INTO sanoma_connections (id,vendor,method,owner,rule,account,scopes,revision,definition,credential,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING RETURNING id"
        : "UPDATE sanoma_connections SET vendor=$2,method=$3,owner=$4,rule=$5,account=$6,scopes=$7,revision=$8,definition=$9,credential=$10,updated_by=$11,updated_at=now(),status='connected' WHERE id=$1 AND revision=$12 RETURNING id";
    const result = await (await this.db()).query(query, [...values, ...(expected === null ? [] : [expected])]);
    if (!result.rowCount) refuse("The connection changed; reload before binding it");
  }
}

/** Metadata mutations are access operations, so they are policy-reviewed and audited like other effects. */
export const connectionOps = defineConnector("sanoma", {
  connection: {
    disconnect: {
      effect: "access",
      input: z.object({ connection: connectionRefSchema, expectedRevision: z.string() }),
      output: z.object({ id: z.string(), revision: z.string(), status: z.literal("disconnected") }),
      target: (input: { connection: ConnectionRef }) => input.connection.$connection,
    },
    bind: {
      effect: "access",
      input: z.object({
        connection: connectionRefSchema,
        account: z.string().min(1),
        scopes: z.array(z.string()),
        expectedRevision: z.string().nullable(),
      }),
      output: snapshotSchema,
      target: (input: { connection: ConnectionRef }) => input.connection.$connection,
    },
    create: {
      effect: "access",
      input: z.object({ rule: z.string(), account: z.string().min(1), scopes: z.array(z.string()) }),
      output: snapshotSchema,
      target: (input: { rule: string }) => input.rule,
    },
  },
});
const actor = (call: CallContext) => call.principal ?? refuse("Connection mutation needs an authenticated principal");
export function connectionDriver(registry: ConnectionRegistry) {
  return defineDriver(connectionOps, {
    connection: {
      disconnect: (input, call) => registry.disconnect(input.connection, input.expectedRevision, actor(call).id),
      bind: (input, call) =>
        registry.bind(input.connection, input.account, input.scopes, input.expectedRevision, actor(call).id),
      create: (input, call) => registry.create(input.rule, input.account, input.scopes, actor(call)),
    },
  });
}
