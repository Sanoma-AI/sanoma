import type { Principal } from "./define.ts";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  authenticationStoreProblem,
  type AuthenticationStoreProblem,
  decodeCredentials,
  defineAuthentication,
  verifyAuthentication,
  AuthenticationError,
  authenticationProblem,
  type AuthenticationProblem,
  type Authentication,
  type CallAuthentication,
} from "./authentication.ts";
import { type Connector, setupOf, VENDOR, defineConnector, defineDriver, type CallContext } from "./op.ts";
import { isSecret, type Secret } from "./secret.ts";
import { SanomaError } from "./errors.ts";
import {
  SecretStoreError,
  type SecretAccess,
  type SecretLocation,
  type SecretStoreCapabilities,
} from "./secret-store.ts";
import { and, eq, getTableColumns, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import { connectionHealth, connections, connectionSetups } from "./db/company.ts";

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
}
export interface ConnectionSetup {
  target: ConnectionTarget;
  id: string;
  vendor: string;
  method: string;
  definition: string;
  credential?: string;
  location?: SecretLocation;
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
  private readonly db: () => Promise<Db>;
  private readonly secrets?: SecretAccess;
  constructor(catalog: ConnectionCatalog, db: () => Promise<Db>, secrets?: SecretAccess) {
    this.catalog = catalog;
    this.db = db;
    this.secrets = secrets;
  }

  /** Release runtime-owned storage clients; the caller owns the database connection. */
  async close(): Promise<void> {
    await this.secrets?.close();
  }

  /** A direct metadata write uses the same transaction as its default ledger record. */
  onDatabase(db: Db): ConnectionRegistry {
    return new ConnectionRegistry(this.catalog, async () => db, this.secrets);
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
      })
      .from(connections)
      .leftJoin(
        connectionHealth,
        and(eq(connections.id, connectionHealth.connectionId), eq(connections.revision, connectionHealth.revision)),
      )
      .where(or(isNull(connections.owner), eq(connections.owner, actor)));
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
        ...(row?.health &&
          row.checkedAt && {
            health: {
              state: row.health,
              checkedAt: row.checkedAt.toISOString(),
              externallyRenewed: row.externallyRenewed ?? false,
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
        },
      })
      .returning({ checkedAt: connectionHealth.checkedAt });
    if (!checked) refuse("The connection changed during the test; reload before testing it again");
    return { state, checkedAt: checked.checkedAt.toISOString(), externallyRenewed: renewed };
  }

  async test(ref: ConnectionRef, actor: Principal): Promise<ConnectionHealth> {
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
    await this.health(row.id, next, "connected", bundle?.version);
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

  private async row(id: string) {
    const [row] = await (await this.db()).select().from(connections).where(eq(connections.id, id));
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

  /** Only called inside an authorized driver boundary. No value escapes into workflow history. */
  async authenticate(selected: ConnectionSnapshot, actor: string): Promise<CallAuthentication> {
    await this.assertCurrent(selected, actor);
    const method = this.catalog.methods.get(selected.vendor)?.[selected.method];
    if (!method?.verify) throw new AuthenticationError("unsupported");
    const material: CallAuthentication = { method: selected.method, kind: method.kind };
    if (method.kind !== "workload-identity") {
      if (!this.secrets || !selected.credentials) throw new SecretStoreError("unavailable");
      const bundle = await this.secrets.read(selected.credentials.$secret);
      if (!bundle) throw new AuthenticationError("missing");
      material.credentials = decodeCredentials(method, bundle.value);
      material.credentialVersion = bundle.version;
    }
    const identity = await verifyAuthentication(method, material.credentials, {
      connectionId: selected.id,
      vendor: selected.vendor,
    });
    if (identity.account !== selected.account) throw new AuthenticationError("wrong_account");
    if (JSON.stringify(identity.scopes) !== JSON.stringify([...new Set(selected.scopes)].toSorted()))
      throw new AuthenticationError("scope_changed");
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
    const [changed] = await (
      await this.db()
    )
      .update(connections)
      .set({ status: "disconnected", revision, updatedBy: actor })
      .where(and(eq(connections.id, row.id), eq(connections.revision, expectedRevision)))
      .returning({ id: connections.id });
    if (!changed) refuse("The connection changed; reload before disconnecting it");
    return { id: row.id, revision, status: "disconnected" };
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
      }),
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
      target: (input: { target: ConnectionTarget }) =>
        "connection" in input.target ? input.target.connection.$connection : input.target.rule,
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
      target: (input: { target: ConnectionTarget }) =>
        "connection" in input.target ? input.target.connection.$connection : input.target.rule,
    },
    activate: {
      effect: "access",
      input: z.object({ connection: connectionRefSchema, expectedRevision: z.string() }),
      output: snapshotSchema,
      target: (input: { connection: ConnectionRef }) => input.connection.$connection,
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
  return defineDriver(connectionOps, {
    connection: {
      test: (input, call) => registry.test(input.connection, actor(call)),
      prepare: async (input, call) => {
        const setup = await registry.setup(input.target, actor(call), input.requestId);
        if (setup.definition !== input.definition) refuse("The connection changed; review its requirements again");
        return { ...setup, requiredScopes: [...setup.requiredScopes] };
      },
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
      disconnect: (input, call) => registry.disconnect(input.connection, input.expectedRevision, actor(call).id),
      bind: (input, call) =>
        registry.bind(input.connection, input.account, input.scopes, input.expectedRevision, actor(call).id),
      create: (input, call) => registry.create(input.rule, input.account, input.scopes, actor(call)),
    },
  });
}
