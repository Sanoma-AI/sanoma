import type { Principal } from "./define.ts";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  authenticationStoreProblem,
  type AuthenticationStoreProblem,
  decodeCredentials,
  encodeCredentials,
  defineAuthentication,
  verifyAuthentication,
  AuthenticationError,
  authenticationProblem,
  type AuthenticationProblem,
  type Authentication,
  type CallAuthentication,
  type OAuthAuthentication,
  type OAuthGrant,
  type AuthenticationIdentity,
} from "./authentication.ts";
import { type Connector, setupOf, VENDOR, defineConnector, defineDriver, type CallContext } from "./op.ts";
import { isSecret, type Secret } from "./secret.ts";
import { SanomaError } from "./errors.ts";
import {
  SecretStoreError,
  type SecretAccess,
  type SecretLocation,
  type SecretStoreCapabilities,
  type SecretValue,
} from "./secret-store.ts";
import { and, eq, getTableColumns, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import { connectionHealth, connections, connectionSetups } from "./db/company.ts";
import { ConnectionAttempts, oauthApplication, type OAuthClient, refreshGrant, requestGrant } from "./oauth.ts";
import { ConnectionRenewals, LEASE_MS, type Lease, type RenewalState, renewalDue, renewalDueAt } from "./renewal.ts";
import { RENEWAL_AGENT } from "./shared.ts";

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
  /** An `oauth2` method's application credentials (`oauthClient`), which several connections may share. */
  readonly client?: Secret;
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
  /** An `oauth2` method's application credentials, shared by every account the rule creates. */
  readonly client?: Secret;
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
export type ConnectionTarget = { connection: ConnectionRef } | { rule: string };
export interface ConnectionCard {
  id: string;
  vendor: string;
  name: string;
  method: string;
  account?: string;
  scopes: readonly string[];
  requiredScopes: readonly string[];
  expectedAccount?: string;
  revision?: string;
  owner?: string;
  status: "missing" | "connected" | "disconnected" | "pending" | "uncertain" | "configuration_changed";
  location?: SecretLocation;
  boundLocation?: SecretLocation;
  updatedBy?: string;
  updatedAt?: string;
  health?: ConnectionHealth;
  /** An OAuth grant's renewal: when it was last renewed, how that ended, and when the next is due. */
  renewal?: RenewalState;
  /**
   * Why its credentials cannot be kept where they are bound (`authenticationStoreProblem`), found
   * before anyone consents: `read_only` (the method writes them, a refresh, and the binding or
   * store is read-only), `unsupported` (it needs conditional writes the store lacks), `too_large`.
   */
  storageProblem?: AuthenticationStoreProblem;
}
/** A declared account or creation rule whose method's storage needs its binding cannot meet (`storageProblems`). */
export interface ConnectionStorageProblem {
  id: string;
  method: string;
  problem: AuthenticationStoreProblem;
  /** Where its credentials are bound; none for a rule's, kept under a name of their own, Sanoma's, in the store. */
  location?: SecretLocation;
}
export interface ConnectionHealth {
  state:
    | AuthenticationProblem
    | "connected"
    | "disconnected"
    | "pending"
    | "configuration_changed"
    | "store_denied"
    | "invalid";
  checkedAt: string;
  externallyRenewed: boolean;
  /** When the credential last verified stops working (ISO 8601), when its verifier says. */
  expiresAt?: string;
  /** When an OAuth grant was last renewed (ISO 8601). */
  refreshedAt?: string;
}
export interface ConnectionSetup {
  target: ConnectionTarget;
  id: string;
  vendor: string;
  method: string;
  definition: string;
  credential?: string;
  location?: SecretLocation;
  /** An `oauth2` method's application credentials: the secret's name, never its value. */
  client?: string;
  expectedRevision: string | null;
  requiredScopes: readonly string[];
  expectedAccount?: string;
  previousAccount?: string;
  previousLocation?: SecretLocation;
}
const idPart = /^[a-z][a-z0-9-]{0,63}$/;
/** A value bound to the environment or bootstrap: read-only to Sanoma, whatever the store. */
const BOUND: SecretStoreCapabilities = {
  writable: false,
  maxBytes: Number.MAX_SAFE_INTEGER,
  conditionalWrites: "none",
  deletion: "unsupported",
  changeDetection: "read",
};

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
export const connectionTargetSchema = z.union([
  z.object({ connection: connectionRefSchema }),
  z.object({ rule: z.string().min(1) }),
]);
const setupSchema = z.object({
  target: connectionTargetSchema,
  id: z.string(),
  vendor: z.string(),
  method: z.string(),
  definition: z.string(),
  credential: z.string().optional(),
  location: z
    .object({ store: z.string(), namespace: z.string(), path: z.string(), management: z.enum(["sanoma", "external"]) })
    .optional(),
  client: z.string().optional(),
  expectedRevision: z.string().nullable(),
  requiredScopes: z.array(z.string()),
  expectedAccount: z.string().optional(),
  previousAccount: z.string().optional(),
  previousLocation: z
    .object({ store: z.string(), namespace: z.string(), path: z.string(), management: z.enum(["sanoma", "external"]) })
    .optional(),
});

export function defineConnection<C extends Connector<any, any>>(
  connector: C,
  options: {
    name: string;
    method: string;
    credentials?: Secret;
    /** For an `oauth2` method: the secret holding the company's OAuth application (`oauthClient`). */
    client?: Secret;
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
  checkClient(auth, options.client, options.credentials);
  return Object.freeze({
    $connection: `${vendor}/${options.name}`,
    vendor,
    name: options.name,
    method: options.method,
    ...(options.credentials && { credentials: Object.freeze({ $secret: options.credentials.$secret }) }),
    ...(options.client && { client: Object.freeze({ $secret: options.client.$secret }) }),
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
    /** For an `oauth2` method: the secret holding the company's OAuth application (`oauthClient`). */
    client?: Secret;
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
  const auth = setupOf(connector).authentication?.[options.method];
  if (!auth) refuse("The connector does not declare this authentication method");
  checkClient(auth, options.client);
  return Object.freeze({
    name: options.name,
    vendor: connector[VENDOR].id,
    method: options.method,
    createBy: Object.freeze(options.createBy.map((x) => (typeof x === "string" ? x : Object.freeze({ ...x })))),
    scopes: Object.freeze([...(options.scopes ?? [])]),
    ...(options.client && { client: Object.freeze({ $secret: options.client.$secret }) }),
  });
}

/** An `oauth2` method needs its application's secret, apart from the grant's; no other method takes one. */
function checkClient(auth: Authentication, client: Secret | undefined, credentials?: Secret): void {
  if (auth.kind !== "oauth2") {
    if (client !== undefined) refuse("Only an OAuth method takes application credentials");
  } else if (!isSecret(client) || client.$secret === credentials?.$secret)
    refuse("An OAuth connection needs its application's client secret, apart from its grant");
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
    checkClient(auth, d.client, d.credentials);
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
    checkClient(methods.get(r.vendor)![r.method]!, r.client);
    dynamic.set(id, r);
  }
  return { definitions: defined, rules: dynamic, methods };
}

/** What a connection's row says of it, as `db/company.ts` declares it. */
export type ConnectionStatus = "connected" | "disconnected" | "pending" | "uncertain";
/** A connection's metadata, what `save` writes: its row less what the save sets. */
type ConnectionRow = Omit<typeof connections.$inferSelect, "location" | "updatedBy" | "updatedAt">;
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
  /** OAuth consent attempts, on the same database: what the callback and the exchange share. */
  readonly attempts: ConnectionAttempts;
  /**
   * OAuth grants' renewal leases and due times, always on the registry's own database, never a
   * direct call's transaction (`onDatabase`): another process must see a lease at once, and an
   * `uncertain` outcome must stay recorded when the call that met it fails.
   */
  readonly renewals: ConnectionRenewals;
  private readonly db: () => Promise<Db>;
  /** The registry's own database, outside any direct call's transaction. */
  private readonly own: () => Promise<Db>;
  private readonly secrets?: SecretAccess;
  constructor(catalog: ConnectionCatalog, db: () => Promise<Db>, secrets?: SecretAccess, own = db) {
    this.catalog = catalog;
    this.db = db;
    this.own = own;
    this.secrets = secrets;
    this.attempts = new ConnectionAttempts(own);
    this.renewals = new ConnectionRenewals(own);
  }

  /** True when a declared connection or rule connects by an `oauth2` method that renews its grants: the worker then renews them when due. */
  get renews(): boolean {
    return [...this.catalog.definitions.values(), ...this.catalog.rules.values()].some(
      (c) => this.oauthMethod(c.vendor, c.method)?.oauth.refresh !== undefined,
    );
  }

  /** The `oauth2` method `method` of `vendor`; undefined for a method of another kind. */
  oauthMethod(vendor: string, method: string): OAuthAuthentication | undefined {
    const found = this.catalog.methods.get(vendor)?.[method];
    return found?.kind === "oauth2" ? found : undefined;
  }

  /** Release runtime-owned storage clients; the caller owns the database connection. */
  async close(): Promise<void> {
    await this.secrets?.close();
  }

  /** A direct metadata write uses the same transaction as its default ledger record. */
  onDatabase(db: Db): ConnectionRegistry {
    return new ConnectionRegistry(this.catalog, async () => db, this.secrets, this.own);
  }

  /** Safe card data only. Listing does not read credential values or contact a vendor. */
  async cards(actor: string): Promise<ConnectionCard[]> {
    const rows = await (
      await this.db()
    )
      .select({
        ...getTableColumns(connections),
        health: connectionHealth.health,
        checkedAt: connectionHealth.checkedAt,
        externallyRenewed: connectionHealth.externallyRenewed,
        expiresAt: connectionHealth.expiresAt,
      })
      .from(connections)
      .leftJoin(
        connectionHealth,
        and(eq(connections.id, connectionHealth.connectionId), eq(connections.revision, connectionHealth.revision)),
      )
      .where(or(isNull(connections.owner), eq(connections.owner, actor)));
    const renewals = await this.renewals.states();
    const found = new Map(rows.map((r) => [r.id, r]));
    const ids = new Set([...this.catalog.definitions.keys(), ...rows.filter((r) => r.rule).map((r) => r.id)]);
    const cards: ConnectionCard[] = [];
    for (const id of ids) {
      const row = found.get(id);
      const declaration = row?.rule ? this.catalog.rules.get(row.rule) : this.catalog.definitions.get(id);
      if (!declaration || (row?.rule && row.owner !== actor)) continue;
      const method = this.catalog.methods.get(declaration.vendor)?.[declaration.method];
      if (!method) continue;
      const credential =
        method.kind === "workload-identity"
          ? undefined
          : "default" in declaration
            ? declaration.credentials?.$secret
            : row?.credential;
      const location = credential && this.secrets ? this.secrets.location(credential) : undefined;
      const storageProblem = this.storeProblem(method, location);
      cards.push({
        id,
        vendor: declaration.vendor,
        name: row?.rule ? id.slice(declaration.vendor.length + 1) : declaration.name,
        method: declaration.method,
        ...(row && { account: row.account, revision: row.revision }),
        scopes: row?.scopes ?? [],
        requiredScopes: declaration.scopes,
        ...("account" in declaration && declaration.account && { expectedAccount: declaration.account }),
        ...(row?.owner && { owner: row.owner }),
        status: !row
          ? "missing"
          : row.definition !== this.bindingFingerprint(declaration, method, credential)
            ? "configuration_changed"
            : row.status,
        ...(location && { location }),
        ...(row?.location && { boundLocation: row.location }),
        ...(row?.updatedBy && { updatedBy: row.updatedBy }),
        ...(row?.updatedAt && { updatedAt: row.updatedAt.toISOString() }),
        ...(storageProblem && { storageProblem }),
        ...(row && method.kind === "oauth2" && renewals.has(id) && { renewal: renewals.get(id)! }),
        ...(row?.health &&
          row.checkedAt && {
            health: {
              state: row.health,
              checkedAt: row.checkedAt.toISOString(),
              externallyRenewed: row.externallyRenewed ?? false,
              ...(row.expiresAt && { expiresAt: row.expiresAt.toISOString() }),
            },
          }),
      });
    }
    return cards;
  }

  /** Resolve code-defined setup authority without reading a credential. The request id stays
   * stable across preview, approval and retry; account allocation is scoped to its principal. */
  async setup(target: ConnectionTarget, actor: Principal, requestId: string): Promise<ConnectionSetup> {
    let declaration: ConnectionDefinition | ConnectionRule | undefined;
    let row: typeof connections.$inferSelect | undefined;
    let id: string;
    let credential: string | undefined;
    if ("rule" in target) {
      const rule = this.catalog.rules.get(target.rule);
      if (
        !rule ||
        !rule.createBy.some((by) => (typeof by === "string" ? by === actor.id : actor.groups?.includes(by.group)))
      )
        throw new SanomaError("policy_denied", "This principal cannot create connections under this rule");
      declaration = rule;
      const allocation = createHash("sha256")
        .update(JSON.stringify([actor.id, target.rule, requestId]))
        .digest("hex");
      id = `${target.rule}/${allocation}`;
      credential = `CONNECTION_${allocation.toUpperCase()}`;
      row = await this.row(id);
    } else {
      id = target.connection.$connection;
      row = await this.row(id);
      declaration = row?.rule ? this.catalog.rules.get(row.rule) : this.catalog.definitions.get(id);
      if (!declaration || declaration.vendor !== target.connection.vendor) refuse("The connection is not declared");
      if (row?.rule && row.owner !== actor.id)
        throw new SanomaError("policy_denied", "The connection belongs to another principal");
      credential = "credentials" in declaration ? declaration.credentials?.$secret : (row?.credential ?? undefined);
    }
    const method = this.catalog.methods.get(declaration.vendor)?.[declaration.method];
    if (!method?.verify) throw new AuthenticationError("unsupported");
    if (method.kind === "workload-identity") credential = undefined;
    this.checkStore(method, credential);
    return {
      target,
      id,
      vendor: declaration.vendor,
      method: declaration.method,
      definition: this.bindingFingerprint(declaration, method, credential),
      ...(credential && { credential, ...(this.secrets && { location: this.secrets.location(credential) }) }),
      ...(declaration.client && { client: declaration.client.$secret }),
      expectedRevision: row?.revision ?? null,
      requiredScopes: declaration.scopes,
      ...("account" in declaration && declaration.account && { expectedAccount: declaration.account }),
      ...(row && { previousAccount: row.account }),
      ...(row?.location && { previousLocation: row.location }),
    };
  }

  /** Metadata-only, policy-authorized reservation. Calls cannot use it until activation verifies
   * the saved bundle. A store write failure leaves an explicit uncertain, unusable account. */
  async configure(
    target: ConnectionTarget,
    requestId: string,
    expectedRevision: string | null,
    definition: string,
    account: string,
    scopes: string[],
    actor: Principal,
  ): Promise<ConnectionSnapshot> {
    const setup = await this.setup(target, actor, requestId);
    if (setup.definition !== definition || setup.expectedRevision !== expectedRevision)
      refuse("The connection changed; review it again before saving");
    if (setup.expectedAccount && setup.expectedAccount !== account) throw new AuthenticationError("wrong_account");
    if (setup.requiredScopes.some((s) => !scopes.includes(s))) throw new AuthenticationError("scope_changed");
    const current = await this.row(setup.id);
    const row: ConnectionRow = {
      id: setup.id,
      vendor: setup.vendor,
      method: setup.method,
      owner: "rule" in target ? actor.id : (current?.owner ?? null),
      rule: "rule" in target ? target.rule : (current?.rule ?? null),
      account,
      scopes,
      revision: randomUUID(),
      definition,
      credential: setup.credential ?? null,
      status: "pending",
    };
    await this.save(row, expectedRevision, actor.id);
    return snapshot(row);
  }

  async uncertain(ref: ConnectionRef, revision: string, actor: string): Promise<void> {
    await (
      await this.db()
    )
      .update(connections)
      .set({ status: "uncertain", updatedBy: actor })
      .where(
        and(eq(connections.id, ref.$connection), eq(connections.revision, revision), eq(connections.status, "pending")),
      );
  }

  async storedVersion(id: string, revision: string): Promise<string | undefined> {
    const [row] = await (
      await this.db()
    )
      .select({ credentialVersion: connectionSetups.credentialVersion })
      .from(connectionSetups)
      .where(and(eq(connectionSetups.connectionId, id), eq(connectionSetups.revision, revision)));
    return row?.credentialVersion;
  }

  async recordStoredVersion(id: string, revision: string, version: string): Promise<void> {
    const db = await this.db();
    await db
      .insert(connectionSetups)
      .select(
        db
          .select({
            connectionId: connections.id,
            revision: connections.revision,
            credentialVersion: sql<string>`${version}`.as("credential_version"),
          })
          .from(connections)
          .where(and(eq(connections.id, id), eq(connections.revision, revision), eq(connections.status, "pending"))),
      )
      .onConflictDoNothing();
    if ((await this.storedVersion(id, revision)) !== version) throw new SecretStoreError("conflict");
  }

  private async health(
    id: string,
    revision: string,
    state: ConnectionHealth["state"],
    version?: string,
    external = false,
    expiresAt?: number,
  ): Promise<ConnectionHealth> {
    const db = await this.db();
    const [previous] = await db
      .select({ credentialVersion: connectionHealth.credentialVersion })
      .from(connectionHealth)
      .where(and(eq(connectionHealth.connectionId, id), eq(connectionHealth.revision, revision)));
    const renewed =
      external &&
      previous?.credentialVersion != null &&
      version !== undefined &&
      previous.credentialVersion !== version;
    const credentialVersion = version ?? previous?.credentialVersion ?? null;
    const expires = expiresAt === undefined ? null : new Date(expiresAt);
    const [checked] = await db
      .insert(connectionHealth)
      .select(
        db
          .select({
            connectionId: connections.id,
            revision: connections.revision,
            health: sql<string>`${state}`.as("health"),
            credentialVersion: sql<string | null>`${credentialVersion}`.as("credential_version"),
            externallyRenewed: sql<boolean>`${renewed}`.as("externally_renewed"),
            checkedAt: sql<Date>`now()`.as("checked_at"),
            expiresAt: sql<Date | null>`${expires}::timestamptz`.as("expires_at"),
          })
          .from(connections)
          .where(and(eq(connections.id, id), eq(connections.revision, revision))),
      )
      .onConflictDoUpdate({
        target: connectionHealth.connectionId,
        set: {
          revision,
          health: state,
          credentialVersion,
          externallyRenewed: renewed,
          checkedAt: sql`now()`,
          expiresAt: expires,
        },
      })
      .returning({ checkedAt: connectionHealth.checkedAt });
    if (!checked) refuse("The connection changed during the test; reload before testing it again");
    return {
      state,
      checkedAt: checked.checkedAt.toISOString(),
      externallyRenewed: renewed,
      ...(expires && { expiresAt: expires.toISOString() }),
    };
  }

  async test(ref: ConnectionRef, actor: Principal): Promise<ConnectionHealth> {
    const health = await this.check(ref, actor);
    const refreshedAt = this.oauthMethod(ref.vendor, (await this.row(ref.$connection))?.method ?? "")
      ? (await this.renewals.states()).get(ref.$connection)?.refreshedAt
      : undefined;
    return refreshedAt ? { ...health, refreshedAt } : health;
  }

  private async check(ref: ConnectionRef, actor: Principal): Promise<ConnectionHealth> {
    const setup = await this.setup({ connection: ref }, actor, "test");
    const row = await this.row(setup.id);
    if (!row) return { state: "missing", checkedAt: new Date().toISOString(), externallyRenewed: false };
    if (row.definition !== setup.definition)
      return { state: "configuration_changed", checkedAt: new Date().toISOString(), externallyRenewed: false };
    if (row.status !== "connected") return this.health(row.id, row.revision, row.status);
    try {
      const material = await this.authenticate(snapshot(row), actor.id);
      return this.health(
        row.id,
        row.revision,
        "connected",
        material.credentialVersion,
        setup.location?.management === "external" || !this.secrets?.store.capabilities.writable,
        material.expiresAt,
      );
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const state =
        authenticationProblem(error) ??
        (code === "denied" ? "store_denied" : code === "invalid_value" ? "invalid" : "unavailable");
      return this.health(row.id, row.revision, state);
    }
  }

  async setupState(selected: ConnectionSnapshot, actor: Principal): Promise<"pending" | "connected"> {
    const setup = await this.setup(
      { connection: { vendor: selected.vendor, $connection: selected.id } },
      actor,
      "state",
    );
    const row = await this.row(selected.id);
    if (
      !row ||
      row.definition !== setup.definition ||
      row.account !== selected.account ||
      JSON.stringify(row.scopes.toSorted()) !== JSON.stringify(selected.scopes.toSorted())
    )
      refuse("The connection changed; review it again before saving");
    if (row.status === "connected") return "connected";
    if (row.status !== "pending" || row.revision !== selected.revision)
      refuse("The connection changed; review it again before saving");
    return "pending";
  }

  /** Used inside an authorized operation; verification reads stay inside its driver step. */
  async activate(ref: ConnectionRef, revision: string, actor: Principal): Promise<ConnectionSnapshot> {
    const setup = await this.setup({ connection: ref }, actor, "activate");
    const row = await this.row(setup.id);
    if (
      !row ||
      row.revision !== revision ||
      row.definition !== setup.definition ||
      !["pending", "uncertain"].includes(row.status)
    )
      refuse("The connection changed; review it again before activating");
    const method = this.catalog.methods.get(row.vendor)![row.method]!;
    const bundle = row.credential ? await this.secrets?.read(row.credential) : undefined;
    if (row.credential && !bundle) throw new SecretStoreError("unavailable");
    const identity = await verifyAuthentication(method, bundle && decodeCredentials(method, bundle.value), {
      connectionId: row.id,
      vendor: row.vendor,
    });
    if (identity.account !== row.account) throw new AuthenticationError("wrong_account");
    if (JSON.stringify(identity.scopes) !== JSON.stringify([...new Set(row.scopes)].toSorted()))
      throw new AuthenticationError("scope_changed");
    const next = randomUUID();
    const [activated] = await (
      await this.db()
    )
      .update(connections)
      .set({ status: "connected", revision: next, updatedBy: actor.id })
      .where(and(eq(connections.id, row.id), eq(connections.revision, revision)))
      .returning({ id: connections.id });
    if (!activated) refuse("The connection changed; review it again before activating");
    await this.health(row.id, next, "connected", bundle?.version, false, identity.expiresAt);
    return snapshot({ ...row, revision: next, status: "connected" });
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

  /** Why `method` cannot keep its credentials at `location` (`authenticationStoreProblem`); none without a store or a location. */
  private storeProblem(method: Authentication, location?: SecretLocation): AuthenticationStoreProblem | undefined {
    if (!this.secrets || !location) return undefined;
    return authenticationStoreProblem(
      method,
      location.namespace === "" ? BOUND : this.secrets.store.capabilities,
      location.management,
    );
  }

  private checkStore(method: Authentication, credential?: string | null): void {
    const problem = this.secrets && credential && this.storeProblem(method, this.secrets.location(credential));
    if (problem) throw new SecretStoreError(problem);
  }

  /**
   * Each declared account and creation rule whose method cannot keep its credentials where they
   * are bound, as preview would refuse it: `sanoma check` reports them, before anyone consents.
   * No store or vendor is contacted.
   */
  storageProblems(): ConnectionStorageProblem[] {
    const secrets = this.secrets;
    if (!secrets) return [];
    const problems: ConnectionStorageProblem[] = [];
    for (const d of this.catalog.definitions.values()) {
      const method = this.catalog.methods.get(d.vendor)![d.method]!;
      const credential = method.kind === "workload-identity" ? undefined : d.credentials?.$secret;
      const location = credential ? secrets.location(credential) : undefined;
      const problem = this.storeProblem(method, location);
      if (problem) problems.push({ id: d.$connection, method: d.method, problem, location });
    }
    for (const [id, rule] of this.catalog.rules) {
      const method = this.catalog.methods.get(rule.vendor)![rule.method]!;
      // A rule's accounts are each kept under a name of their own, which no binding names: Sanoma's, in the store.
      const problem = authenticationStoreProblem(method, secrets.store.capabilities, "sanoma");
      if (problem) problems.push({ id, method: rule.method, problem });
    }
    return problems;
  }

  private async row(id: string, db = this.db) {
    const [row] = await (await db()).select().from(connections).where(eq(connections.id, id));
    return row;
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

  /**
   * Only called inside an authorized driver boundary. No value escapes into workflow history. An
   * OAuth grant that renews is renewed first when it is due (`renewalDue`), or when `rejected`
   * names the version a provider just refused (`OAuthFlow.tokenRejected`) and nobody replaced it
   * since. A due renewal that cannot be made now (`unavailable`) keeps a grant still unexpired.
   */
  async authenticate(selected: ConnectionSnapshot, actor: string, rejected?: string): Promise<CallAuthentication> {
    await this.assertCurrent(selected, actor);
    const method = this.catalog.methods.get(selected.vendor)?.[selected.method];
    if (!method?.verify) throw new AuthenticationError("unsupported");
    const material: CallAuthentication = { method: selected.method, kind: method.kind };
    if (method.kind !== "workload-identity") {
      if (!this.secrets || !selected.credentials) throw new SecretStoreError("unavailable");
      let bundle = await this.secrets.read(selected.credentials.$secret);
      if (!bundle) throw new AuthenticationError("missing");
      material.credentials = decodeCredentials(method, bundle.value);
      if (method.kind === "oauth2" && method.oauth.refresh) {
        const grant = material.credentials as OAuthGrant;
        if (rejected !== undefined || renewalDue(grant)) {
          try {
            bundle = await this.renew(selected, method, actor, rejected);
            material.credentials = decodeCredentials(method, bundle.value);
          } catch (error) {
            const usable = rejected === undefined && grant.expiresAt !== undefined && grant.expiresAt > Date.now();
            if (!usable || authenticationProblem(error) !== "unavailable") throw error;
          }
        }
      }
      material.credentialVersion = bundle.version;
    }
    const context = { connectionId: selected.id, vendor: selected.vendor };
    let identity: AuthenticationIdentity;
    try {
      identity = await verifyAuthentication(method, material.credentials, context);
    } catch (error) {
      // The verifier's check is a call too: a grant it finds rejected is renewed once, as a driver's would be.
      if (
        authenticationProblem(error) !== "rejected" ||
        method.kind !== "oauth2" ||
        !method.oauth.refresh ||
        rejected !== undefined
      )
        throw error;
      return this.authenticate(selected, actor, material.credentialVersion);
    }
    if (identity.account !== selected.account) throw new AuthenticationError("wrong_account");
    if (JSON.stringify(identity.scopes) !== JSON.stringify([...new Set(selected.scopes)].toSorted()))
      throw new AuthenticationError("scope_changed");
    // A disconnect or rebind while verification was in flight revokes this invocation too.
    await this.assertCurrent(selected, actor);
    if (identity.expiresAt !== undefined) material.expiresAt = identity.expiresAt;
    return material;
  }

  /**
   * Holds connection `id`'s renewal lease for `body`, which gives it up: while another process
   * holds it, waits (`waiting`'s answer, once it has one, ends the wait instead), at most a lease's
   * time and a little more (`unavailable`).
   */
  private async leased<T>(id: string, body: (lease: Lease) => Promise<T>, waiting?: () => Promise<T | undefined>) {
    const until = Date.now() + LEASE_MS + 5_000;
    for (;;) {
      const lease = await this.renewals.take(id);
      if (lease) return body(lease);
      const settled = await waiting?.();
      if (settled !== undefined) return settled;
      if (Date.now() > until) throw new AuthenticationError("unavailable");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * Marks a connected account whose grant may have been renewed at the provider and not stored
   * `uncertain`, under a new revision so that no call pinned to the old one goes on: Reconnect.
   * Only from `revision`, so a reconnect or disconnect since is never undone.
   */
  private async renewalUncertain(id: string, revision: string, actor: string): Promise<void> {
    await (
      await this.own()
    )
      .update(connections)
      .set({ status: "uncertain", revision: randomUUID(), updatedBy: actor })
      .where(and(eq(connections.id, id), eq(connections.revision, revision), eq(connections.status, "connected")));
  }

  /**
   * The connection's grant renewed with its refresh token (`refreshGrant`), under its lease, and
   * written with the version it replaces. `rejected`: the version a provider refused, renewed unless
   * another process replaced it meanwhile; else renewed only when due (`renewalDue`). A lease whose
   * last holder lapsed after sending, a renewal with no answer, and a renewed grant the store did
   * not keep leave the connection `uncertain`: a refresh token is never sent twice.
   */
  private async renew(
    selected: ConnectionSnapshot,
    method: OAuthAuthentication,
    actor: string,
    rejected?: string,
  ): Promise<SecretValue> {
    const secrets = this.secrets;
    const credential = selected.credentials?.$secret;
    const client = this.declarationOf(selected.id, selected.vendor)?.client?.$secret;
    if (!secrets || !credential || !client) throw new AuthenticationError("unsupported");
    const replaced = (current: SecretValue | undefined) =>
      current !== undefined &&
      (rejected !== undefined ? current.version !== rejected : !renewalDue(decodeCredentials(method, current.value)));
    return this.leased(
      selected.id,
      async ({ holder, abandoned }) => {
        let sent = false;
        try {
          if (abandoned) throw new AuthenticationError("uncertain");
          const current = await secrets.read(credential);
          if (!current) throw new AuthenticationError("missing");
          if (replaced(current)) {
            await this.renewals.release(selected.id, holder);
            return current;
          }
          const row = await this.row(selected.id, this.own);
          if (row?.revision !== selected.revision || row.status !== "connected")
            refuse("The connection changed; start a new call");
          const app = await secrets.read(client);
          if (!app) throw new AuthenticationError("missing");
          const application: OAuthClient = decodeCredentials(oauthApplication, app.value);
          if (!(await this.renewals.sending(selected.id, holder))) throw new AuthenticationError("unavailable");
          sent = true;
          const grant = await refreshGrant(method.oauth, application, decodeCredentials(method, current.value));
          const value = encodeCredentials(method, grant);
          let written: SecretValue;
          try {
            written = await secrets.write(credential, value, { expectedVersion: current.version, by: actor });
          } catch {
            // The provider issued a grant and the store did not keep it (or another writer moved it).
            throw new AuthenticationError("uncertain");
          }
          await this.renewals.release(selected.id, holder, { outcome: "refreshed", dueAt: renewalDueAt(grant) });
          await (
            await this.own()
          )
            .update(connectionHealth)
            .set({
              credentialVersion: written.version,
              expiresAt: grant.expiresAt === undefined ? null : new Date(grant.expiresAt),
            })
            .where(
              and(eq(connectionHealth.connectionId, selected.id), eq(connectionHealth.revision, selected.revision)),
            );
          return { value, version: written.version };
        } catch (error) {
          const problem = authenticationProblem(error) ?? (sent ? "uncertain" : undefined);
          if (problem === "uncertain") await this.renewalUncertain(selected.id, selected.revision, actor);
          // A refusal for good schedules nothing more; one worth asking again keeps its due time.
          await this.renewals.release(
            selected.id,
            holder,
            problem ? { outcome: problem, ...(problem !== "unavailable" && { dueAt: null }) } : {},
          );
          throw problem ? new AuthenticationError(problem) : error;
        }
      },
      async () => {
        const current = await secrets.read(credential);
        return replaced(current) ? current : undefined;
      },
    );
  }

  /**
   * Renews a connected account's OAuth grant if it is due, as `sanoma.connection.refresh` (the
   * worker's renewal agent, when its due time comes; or anyone the policy lets): its outcome, and
   * when the grant now expires. The renewal agent renews any account's; anyone else only the company's or their own.
   */
  async refresh(ref: ConnectionRef, actor: Principal): Promise<{ id: string; refreshed: boolean; expiresAt?: number }> {
    const row = await this.owned(ref, actor.id === RENEWAL_AGENT ? undefined : actor.id);
    const method = this.oauthMethod(row.vendor, row.method);
    if (!method?.oauth.refresh || !row.credential || !this.secrets) throw new AuthenticationError("unsupported");
    if (row.status !== "connected") refuse("The connection is not connected");
    const before = await this.secrets.read(row.credential);
    const after = await this.renew(snapshot(row), method, actor.id);
    const { expiresAt } = decodeCredentials(method, after.value);
    return { id: row.id, refreshed: after.version !== before?.version, ...(expiresAt !== undefined && { expiresAt }) };
  }

  /** The declaration a connection's row is of: its rule's, or the declared connection. */
  private declarationOf(id: string, vendor: string): ConnectionDefinition | ConnectionRule | undefined {
    const declared = this.catalog.definitions.get(id);
    if (declared) return declared.vendor === vendor ? declared : undefined;
    const rule = [...this.catalog.rules.entries()].find(([ruleId]) => id.startsWith(`${ruleId}/`))?.[1];
    return rule?.vendor === vendor ? rule : undefined;
  }

  /**
   * The `oauth2` exchange, inside the worker's operation boundary: takes the attempt's code once,
   * posts it with the verifier and the stored application credentials to the token endpoint,
   * verifies the grant's account against the declaration, reserves a pending revision, and writes
   * the grant to the selected store with the version it replaces. Returns metadata only. A store
   * failure after the provider issued the grant leaves the connection `uncertain` (reconnect);
   * the code is never sent again.
   */
  async exchange(
    target: ConnectionTarget,
    requestId: string,
    attempt: string,
    actor: Principal,
  ): Promise<{ connection: ConnectionRef; revision: string; account: string; scopes: string[]; expiresAt?: number }> {
    // Whether the code went to the token endpoint: past that, a failure may leave a grant unkept.
    let sent = false;
    try {
      const setup = await this.setup(target, actor, requestId);
      const method = this.catalog.methods.get(setup.vendor)![setup.method]!;
      if (method.kind !== "oauth2" || !setup.client || !setup.credential || !this.secrets)
        throw new AuthenticationError("unsupported");
      // Connected, disconnected or reconnected by someone else since consent: not this grant's to replace.
      if ("connection" in target && (target.connection.revision ?? null) !== setup.expectedRevision)
        refuse("The connection changed since consent; connect again");
      const taken = await this.attempts.take(attempt, actor.id, setup.id);
      const stored = await this.secrets.read(setup.client);
      if (!stored) throw new AuthenticationError("missing");
      const client = decodeCredentials(oauthApplication, stored.value);
      // The application changed since consent: its code was issued to another client.
      if (client.clientId !== taken.clientId) throw new AuthenticationError("rejected");
      sent = true;
      const grant = await requestGrant(method.oauth, client, taken);
      const identity = await verifyAuthentication(method, grant, { connectionId: setup.id, vendor: setup.vendor });
      // Refuses another account, or a grant without a required scope, before anything is stored.
      const selected = await this.configure(
        target,
        requestId,
        setup.expectedRevision,
        setup.definition,
        identity.account,
        [...identity.scopes],
        actor,
      );
      const ref = { vendor: selected.vendor, $connection: selected.id };
      const secrets = this.secrets;
      const credential = setup.credential;
      // Under the renewal lease: a renewal of the grant this one replaces never writes over it.
      const kept = await this.leased(selected.id, async ({ holder }) => {
        try {
          const current = await secrets.read(credential);
          const written = await secrets.write(credential, encodeCredentials(method, grant), {
            expectedVersion: current?.version ?? null,
            by: actor.id,
          });
          await this.recordStoredVersion(selected.id, selected.revision, written.version);
        } catch {
          await this.renewals.release(selected.id, holder);
          return false;
        }
        await this.renewals.release(selected.id, holder, { fresh: true, dueAt: renewalDueAt(grant) });
        return true;
      }).catch(() => false);
      if (!kept) {
        // The provider issued the grant; whether it is stored is not known. Reconnect, never replay.
        await this.uncertain(ref, selected.revision, actor.id);
        throw new AuthenticationError("uncertain");
      }
      await this.attempts.settle(attempt, actor.id, "exchanged");
      return {
        connection: ref,
        revision: selected.revision,
        account: identity.account,
        scopes: [...identity.scopes],
        ...(identity.expiresAt !== undefined && { expiresAt: identity.expiresAt }),
      };
    } catch (error) {
      // A take that found the code gone (a retried step) or expired ends the attempt so too.
      const problem = authenticationProblem(error) ?? (sent ? "uncertain" : "unavailable");
      await this.attempts.settle(attempt, actor.id, problem);
      throw new AuthenticationError(problem);
    }
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

  /** A declared connection's row, refused for another principal's (`owner`, unless undefined: anyone's). */
  private async owned(ref: ConnectionRef, owner: string | undefined) {
    const row = await this.row(ref.$connection);
    if (
      !row ||
      row.vendor !== ref.vendor ||
      (row.rule ? !this.catalog.rules.has(row.rule) : !this.catalog.definitions.has(row.id))
    )
      refuse("The connection is not declared");
    if (row.rule && owner !== undefined && row.owner !== owner)
      throw new SanomaError("policy_denied", "The connection belongs to another principal");
    return row;
  }

  /**
   * Makes the account unusable under a new revision. An OAuth grant Sanoma keeps is deleted with
   * it, and its renewal forgotten; the OAuth application (`client`), which other accounts may
   * share, stays. Any other method's value stays where it is, and an externally managed value is
   * never deleted. Calls already at the provider are not undone.
   */
  async disconnect(
    ref: ConnectionRef,
    expectedRevision: string,
    actor: string,
  ): Promise<{ id: string; revision: string; status: "disconnected" }> {
    const row = await this.owned(ref, actor);
    const revision = randomUUID();
    const [changed] = await (
      await this.db()
    )
      .update(connections)
      .set({ status: "disconnected", revision, updatedBy: actor })
      .where(and(eq(connections.id, row.id), eq(connections.revision, expectedRevision)))
      .returning({ id: connections.id });
    if (!changed) refuse("The connection changed; reload before disconnecting it");
    if (this.oauthMethod(row.vendor, row.method) && row.credential && this.secrets) {
      const location = this.secrets.location(row.credential);
      // A store that cannot delete keeps it, unusable: the account's new revision refuses every call.
      if (
        location.management === "sanoma" &&
        location.namespace !== "" &&
        this.secrets.store.capabilities.deletion !== "unsupported"
      ) {
        await this.renewals.forget(row.id);
        await this.dropGrant(row.credential, actor);
      }
    }
    return { id: row.id, revision, status: "disconnected" };
  }

  /** Deletes a stored grant, once more should a renewal have replaced it between the read and the delete. */
  private async dropGrant(credential: string, actor: string): Promise<void> {
    try {
      await this.secrets!.delete(credential, { by: actor });
    } catch (error) {
      if ((error as { code?: string })?.code !== "conflict") throw error;
      await this.secrets!.delete(credential, { by: actor });
    }
  }

  /**
   * Revokes an OAuth grant at the provider (the method's `revoke`, with the company's application),
   * then disconnects the account as `disconnect` does, its grant deleted. `unsupported` for a
   * method that cannot revoke, and nothing changes when the provider did not confirm (`unavailable`).
   */
  async revoke(
    ref: ConnectionRef,
    expectedRevision: string,
    actor: string,
  ): Promise<{ id: string; revision: string; status: "disconnected" }> {
    const row = await this.owned(ref, actor);
    const method = this.oauthMethod(row.vendor, row.method);
    const client = this.declarationOf(row.id, row.vendor)?.client?.$secret;
    if (!method?.revoke || !row.credential || !client || !this.secrets) throw new AuthenticationError("unsupported");
    if (row.revision !== expectedRevision) refuse("The connection changed; reload before revoking it");
    const [bundle, app] = [await this.secrets.read(row.credential), await this.secrets.read(client)];
    if (!bundle || !app) throw new AuthenticationError("missing");
    try {
      await method.revoke(decodeCredentials(method, bundle.value), decodeCredentials(oauthApplication, app.value));
    } catch {
      throw new AuthenticationError("unavailable");
    }
    return this.disconnect(ref, expectedRevision, actor);
  }

  private async save(row: ConnectionRow, expected: string | null, actor: string): Promise<void> {
    const db = await this.db();
    const values = {
      vendor: row.vendor,
      method: row.method,
      owner: row.owner,
      rule: row.rule,
      account: row.account,
      scopes: row.scopes,
      revision: row.revision,
      definition: row.definition,
      credential: row.credential,
      updatedBy: actor,
      status: row.status,
      location: row.credential && this.secrets ? this.secrets.location(row.credential) : null,
    };
    const [saved] =
      expected === null
        ? await db
            .insert(connections)
            .values({ id: row.id, ...values })
            .onConflictDoNothing()
            .returning({ id: connections.id })
        : await db
            .update(connections)
            .set(values)
            .where(and(eq(connections.id, row.id), eq(connections.revision, expected)))
            .returning({ id: connections.id });
    if (!saved) refuse("The connection changed; reload before binding it");
  }
}

/** A setup operation's policy target: the declared connection's id, or the rule's. */
const setupTarget = (input: { target: ConnectionTarget }) =>
  "connection" in input.target ? input.target.connection.$connection : input.target.rule;

/** Metadata mutations are access operations, so they are policy-reviewed and audited like other effects. */
export const connectionOps = defineConnector("sanoma", {
  connection: {
    test: {
      effect: "read",
      input: z.object({ connection: connectionRefSchema }),
      output: z.object({
        state: z.enum([
          "missing",
          "expired",
          "revoked",
          "rejected",
          "wrong_account",
          "scope_changed",
          "uncertain",
          "unavailable",
          "unsupported",
          "connected",
          "disconnected",
          "pending",
          "configuration_changed",
          "store_denied",
          "invalid",
        ]),
        checkedAt: z.string(),
        externallyRenewed: z.boolean(),
        // When the verified credential stops working, and when an OAuth grant was last renewed (ISO 8601).
        expiresAt: z.string().optional(),
        refreshedAt: z.string().optional(),
      }),
      target: (input: { connection: ConnectionRef }) => input.connection.$connection,
    },
    refresh: {
      effect: "access",
      description:
        "Renew a connected account's OAuth grant with its refresh token, when it is due; the worker's renewal agent calls it",
      input: z.object({ connection: connectionRefSchema }),
      output: z.object({ id: z.string(), refreshed: z.boolean(), expiresAt: z.number().optional() }),
      target: (input: { connection: ConnectionRef }) => input.connection.$connection,
    },
    revoke: {
      effect: "access",
      description:
        "Revoke an account's OAuth grant at the provider, then disconnect it and delete the grant; the OAuth application stays",
      input: z.object({ connection: connectionRefSchema, expectedRevision: z.string() }),
      output: z.object({ id: z.string(), revision: z.string(), status: z.literal("disconnected") }),
      target: (input: { connection: ConnectionRef }) => input.connection.$connection,
    },
    prepare: {
      effect: "access",
      input: z.object({
        target: connectionTargetSchema,
        requestId: z.string().min(1),
        definition: z.string(),
        authorization: z.string(),
      }),
      output: setupSchema,
      target: setupTarget,
    },
    configure: {
      effect: "access",
      input: z.object({
        target: connectionTargetSchema,
        requestId: z.string().min(1),
        expectedRevision: z.string().nullable(),
        definition: z.string(),
        account: z.string().min(1),
        scopes: z.array(z.string()),
      }),
      output: snapshotSchema,
      target: setupTarget,
    },
    activate: {
      effect: "access",
      input: z.object({ connection: connectionRefSchema, expectedRevision: z.string() }),
      output: snapshotSchema,
      target: (input: { connection: ConnectionRef }) => input.connection.$connection,
    },
    authorize: {
      effect: "access",
      description: "Admit an OAuth consent for a connection; the app then makes the attempt outside workflow history",
      input: z.object({
        target: connectionTargetSchema,
        requestId: z.string().min(1),
        definition: z.string(),
        redirectUri: z.string().url(),
        // Whether Connect replaces the stored OAuth application (its client ID and secret), which
        // every account of the connection or rule shares: in the ledger, and a policy can hold it.
        replacesApplication: z.boolean(),
        authorization: z.string(),
      }),
      output: setupSchema,
      target: setupTarget,
    },
    exchange: {
      effect: "access",
      description:
        "Exchange an OAuth attempt's code for a grant, stored in the selected store; only the connect workflow calls it",
      input: z.object({ target: connectionTargetSchema, requestId: z.string().min(1), attempt: z.string().min(1) }),
      output: z.object({
        connection: connectionRefSchema,
        revision: z.string(),
        account: z.string(),
        scopes: z.array(z.string()),
        expiresAt: z.number().optional(),
      }),
      target: setupTarget,
    },
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
  // Prepare and authorize admit a setup under policy: the requirements as reviewed, no credential read.
  const gate = async (
    input: { target: ConnectionTarget; requestId: string; definition: string },
    call: CallContext,
  ): Promise<z.output<typeof setupSchema>> => {
    const setup = await registry.setup(input.target, actor(call), input.requestId);
    if (setup.definition !== input.definition) refuse("The connection changed; review its requirements again");
    return { ...setup, requiredScopes: [...setup.requiredScopes] };
  };
  return defineDriver(connectionOps, {
    connection: {
      test: (input, call) => registry.test(input.connection, actor(call)),
      refresh: (input, call) => registry.refresh(input.connection, actor(call)),
      revoke: (input, call) => registry.revoke(input.connection, input.expectedRevision, actor(call).id),
      prepare: gate,
      configure: (input, call) =>
        registry.configure(
          input.target,
          input.requestId,
          input.expectedRevision,
          input.definition,
          input.account,
          input.scopes,
          actor(call),
        ),
      activate: (input, call) => registry.activate(input.connection, input.expectedRevision, actor(call)),
      authorize: gate,
      exchange: (input, call) => registry.exchange(input.target, input.requestId, input.attempt, actor(call)),
      disconnect: (input, call) => registry.disconnect(input.connection, input.expectedRevision, actor(call).id),
      bind: (input, call) =>
        registry.bind(input.connection, input.account, input.scopes, input.expectedRevision, actor(call).id),
      create: (input, call) => registry.create(input.rule, input.account, input.scopes, actor(call)),
    },
  });
}
