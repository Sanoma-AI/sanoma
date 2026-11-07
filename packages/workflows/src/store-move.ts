import { timingSafeEqual } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { type Authentication, authenticationStoreProblem } from "./authentication.ts";
import type { ConnectionRegistry } from "./connection.ts";
import { openStore } from "./credentials.ts";
import type { Db } from "./db.ts";
import { connectionRenewals, connections, secretMoveItems, secretMoves } from "./db/company.ts";
import { defineConnector, defineDriver, DriverError } from "./op.ts";
import { SECRET_NAME } from "./secret.ts";
import { checkSecretStore } from "./secret-store-check.ts";
import {
  type SecretAccess,
  type SecretConfiguration,
  type SecretStore,
  type SecretLocation,
  type SecretStoreCapabilities,
  SecretStoreError,
  type SecretValue,
  secretStoreCall,
  STORE_NAME,
  storeError,
} from "./secret-store.ts";
import { ACTIVE_MOVE_PHASES } from "./shared.ts";

// Moving the company's secrets from the selected store to another (`secrets.stores`), as the
// runtime's own operations `sanoma.storeMigration.*`, which the built-in `migrate-store` runs in
// order (`store-move-workflow.ts`): plan, prepare, transfer, verify, cutover, retire. Each value is
// read and written inside this driver alone; what leaves it, into the ledger and DBOS's history,
// is names, paths, versions, sizes and kinds. The move's progress is rows of
// `sanoma_secret_moves` and `sanoma_secret_move_items`: receipts of versions, never a value or a
// hash of one. The source stays authoritative until the deployed code selects the destination;
// from the transfer on, writes at the source are refused (`fenced`, in `credentials.ts`), so the
// move is the one writer while values move and the source has none after its cutover.

/** Where a move is: prepared, copying (`transferring`, its source fenced), checked, switched, retired, or cancelled before its cutover. */
export type MovePhase = "prepared" | "transferring" | "verified" | "cut_over" | "retired" | "cancelled";
/** What a moved secret holds: a connection's credential bundle (its method's kind), an OAuth application (`oauth-client`), or a plain value. */
export type MoveItemKind = "value" | "oauth-client" | Authentication["kind"];
/**
 * What the move does with a secret: copies it, or not: `kept` (an OAuth application the
 * destination holds its own of, which stays), `external` (its owner's), `bound` (the environment
 * or a bootstrap key), `missing` (nothing stored).
 */
export type MoveItemAction = "copy" | "kept" | "external" | "bound" | "missing";
/** A copied secret's receipt: not yet copied, copied, read back equal, changed at the source since its copy, then deleted at the source or kept there. */
export type MoveItemState = "pending" | "copied" | "verified" | "stale" | "retired" | "retained";

const MoveId = z.string().min(1).max(512);
export const StoreName = z.string().regex(STORE_NAME, "a name in `secrets.stores`");
const Capabilities = z.object({
  writable: z.boolean(),
  maxBytes: z.number(),
  conditionalWrites: z.enum(["atomic", "coordinated", "none"]),
  deletion: z.enum(["destroy", "soft-delete", "unsupported"]),
  changeDetection: z.enum(["read", "watch"]),
});
const Endpoint = z.object({ store: z.string(), namespace: z.string() });
const Item = z.object({
  name: z.string(),
  kind: z.enum(["value", "oauth-client", "api-key", "fields", "signed", "oauth2"]),
  management: z.enum(["sanoma", "external"]),
  action: z.enum(["copy", "kept", "external", "bound", "missing"]),
  sourcePath: z.string(),
  destinationPath: z.string(),
  bytes: z.number().optional(),
  sourceVersion: z.string().optional(),
  /** The connections whose credentials (or OAuth application) these are. */
  connections: z.array(z.string()),
  reauthorize: z.enum(["client_changed", "client_missing"]).optional(),
});
type Item = z.infer<typeof Item>;
const PlanOutput = z.object({
  source: Endpoint,
  destination: Endpoint.extend({ name: z.string() }),
  capabilities: z.object({ source: Capabilities, destination: Capabilities }),
  items: z.array(Item),
  /** What prepare would refuse: the destination's access, a capability it lacks, a value too large for it. */
  problems: z.array(z.string()),
});
export type StoreMovePlan = z.infer<typeof PlanOutput>;
export const Names = z.array(z.string().regex(SECRET_NAME)).max(500).optional();
const target = ({ move }: { move: string }) => move;
/** The author a move writes its copies as: how a resumed transfer knows its own. */
const writer = (move: string) => `move:${move}`;

/** The runtime's operations of a move between stores, on the vendor `sanoma`: registered in every config, so a policy may name them. */
export const storeMoveOps = defineConnector("sanoma", {
  storeMigration: {
    plan: {
      effect: "read",
      idempotent: true,
      description:
        "Plan moving the secrets Sanoma knows (connections, OAuth applications, bindings, data files' secrets) from the selected store to another in `secrets.stores`: names, paths, versions, sizes and kinds, never a value",
      input: z.object({ to: StoreName, names: Names }),
      output: PlanOutput,
      target: ({ to }: { to: string }) => to,
    },
    prepare: {
      effect: "access",
      idempotent: true,
      description:
        "Check the destination store (its conformance in a disposable namespace, its capabilities against each secret) and record the move's plan; flags OAuth grants whose application differs at the destination",
      input: z.object({
        move: MoveId,
        to: StoreName,
        names: Names,
        retainHours: z
          .number()
          .int()
          .min(0)
          .max(24 * 366),
      }),
      output: z.object({
        move: z.string(),
        copy: z.number(),
        reauthorize: z.array(z.string()),
        checks: z.array(z.object({ name: z.string(), ok: z.boolean() })),
      }),
      target,
    },
    transfer: {
      effect: "write",
      idempotent: true,
      description:
        "Pause writes at the source, then copy each value into the destination under its own protection, with expected versions at both ends; a repeat skips what already matches and never replaces a value the move did not write",
      input: z.object({ move: MoveId }),
      output: z.object({
        copied: z.array(z.string()),
        unchanged: z.number(),
        missing: z.array(z.string()),
        // Nothing paused or copied yet: an OAuth renewal at the source has sent its refresh token, and stores its grant first.
        renewing: z.boolean(),
      }),
      target,
    },
    verify: {
      effect: "read",
      idempotent: true,
      description:
        "Read each copy back at both ends and compare it, by version and value, in the runtime; answers what comes next and which store the deployed code selects",
      input: z.object({ move: MoveId }),
      output: z.object({
        next: z.enum(["transfer", "wait", "cutover", "cancelled"]),
        stale: z.array(z.string()),
        selected: z.enum(["source", "destination", "neither"]),
      }),
      target,
    },
    cutover: {
      effect: "access",
      idempotent: true,
      description:
        "Make the destination the one store written, once the deployed code selects it: checks the copies once more, rebinds the connections to it and starts the rollback window; the source stays refused to writers",
      input: z.object({ move: MoveId }),
      output: z.object({
        cutoverAt: z.number(),
        retainUntil: z.number(),
        rebound: z.array(z.string()),
        reauthorize: z.array(z.string()),
      }),
      target,
    },
    retire: {
      effect: "write",
      idempotent: true,
      description:
        "After the rollback window, delete the copies Sanoma owns at the source, each at the version copied; external secrets, changed values, provider-retained versions and vendor-side revocation are reported, not touched",
      input: z.object({ move: MoveId }),
      output: z.object({
        retired: z.array(z.string()),
        retained: z.array(z.object({ name: z.string(), why: z.enum(["external", "changed", "unsupported"]) })),
        deletion: z.enum(["destroy", "soft-delete", "unsupported"]),
        vendorRevocation: z.literal("not_performed"),
      }),
      target,
    },
    cancel: {
      effect: "write",
      idempotent: true,
      description:
        "Abandon a move before its cutover: writes at the source resume; copies already made stay inactive at the destination",
      input: z.object({ move: MoveId }),
      output: z.object({ phase: z.literal("cancelled"), atDestination: z.array(z.string()) }),
      target,
    },
  },
});

const refuse = (message: string): never => {
  throw new DriverError(`Store move: ${message}`, { retryable: false });
};
/** A store's failure, by its sanitized code alone: never its cause. */
async function stored<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DriverError) throw error;
    const code = storeError(error) ? error.code : "unavailable";
    throw new DriverError(`Store move: a store answered ${code}`, { retryable: code === "unavailable" });
  }
}
const same = (a: SecretValue | undefined, b: SecretValue | undefined) => {
  if (!a || !b) return false;
  const x = Buffer.from(a.value, "utf8"),
    y = Buffer.from(b.value, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
};
const capabilities = (store: SecretStore): SecretStoreCapabilities => ({ ...store.capabilities });
const ACTIVE: readonly MovePhase[] = ACTIVE_MOVE_PHASES;
/** Where prepare checks the destination's conformance: disposable, never a move's own namespace. */
const CHECK_NAMESPACE = "sanoma-move-check";

/** What the move driver reads: the config's secrets, the selected store's access, the connections and the database its rows are on. */
export interface StoreMoveContext {
  config: SecretConfiguration;
  secrets: SecretAccess;
  registry: ConnectionRegistry;
  db: () => Promise<Db>;
  /** The secret names the data files' declarations reference (`secret("NAME")`), and why any file did not load. */
  declared: () => Promise<{ names: string[]; problems: string[] }>;
}

export function storeMoveDriver({ config, secrets, registry, db, declared }: StoreMoveContext) {
  const selected = () => ({ store: secrets.store.id, namespace: secrets.namespace });
  /** The store at one end of a move: the selected one, or the `secrets.stores` entry with its id and namespace. */
  async function endpoint<T>(store: string, namespace: string, use: (s: SecretStore) => Promise<T>): Promise<T> {
    if (secrets.store.id === store && secrets.namespace === namespace) return use(secrets.store);
    const entries = Object.values(config.stores ?? {}).filter(
      (e) => (e.namespace ?? "default") === namespace && (e.store?.id ?? "postgres") === store,
    );
    if (entries.length !== 1)
      return refuse(
        `${store} (namespace ${namespace}) is ${entries.length ? "named twice" : "neither the selected store nor"} in \`secrets.stores\``,
      );
    const opened = openStore(entries[0]!, db);
    try {
      return await use(opened.store);
    } finally {
      await opened.close().catch(() => {});
    }
  }
  /** Each secret Sanoma knows, by name: its kind, the connections it serves, their method, and an OAuth grant's application. */
  async function inventory(extra: readonly string[], problems: string[]) {
    type Known = { kind: MoveItemKind; connections: Set<string>; auth?: Authentication; client?: string };
    const known = new Map<string, Known>();
    const add = (name: string, kind: MoveItemKind, connection?: string, auth?: Authentication, client?: string) => {
      const entry = known.get(name) ?? { kind, connections: new Set<string>() };
      if (entry.kind === "value") entry.kind = kind;
      if (connection) entry.connections.add(connection);
      entry.auth ??= auth;
      entry.client ??= client;
      known.set(name, entry);
    };
    const { catalog } = registry;
    const methodOf = (c: { vendor: string; method: string }) => catalog.methods.get(c.vendor)?.[c.method];
    const credential = (name: string, id: string, auth: Authentication | undefined, client?: string) => {
      if (auth) add(name, auth.kind, id, auth, client);
    };
    for (const d of catalog.definitions.values()) {
      if (d.client) add(d.client.$secret, "oauth-client", d.$connection);
      if (d.credentials) credential(d.credentials.$secret, d.$connection, methodOf(d), d.client?.$secret);
    }
    for (const [id, rule] of catalog.rules) if (rule.client) add(rule.client.$secret, "oauth-client", id);
    const rows = await (
      await db()
    )
      .select({ id: connections.id, rule: connections.rule, credential: connections.credential })
      .from(connections)
      .where(and(isNotNull(connections.rule), isNotNull(connections.credential)));
    for (const row of rows) {
      const rule = catalog.rules.get(row.rule!);
      if (rule) credential(row.credential!, row.id, methodOf(rule), rule.client?.$secret);
    }
    for (const name of Object.keys(config.bindings ?? {})) add(name, "value");
    const files = await declared();
    for (const problem of files.problems) problems.push(`data files: ${problem}`);
    for (const name of [...files.names, ...extra]) add(name, "value");
    return known;
  }
  async function planOf(to: string, names?: readonly string[]): Promise<StoreMovePlan> {
    const entry = config.stores?.[to];
    if (!entry) return refuse(`no store is named ${to} in \`secrets.stores\``);
    const source = selected();
    const destination = { name: to, store: entry.store?.id ?? "postgres", namespace: entry.namespace ?? "default" };
    if (destination.store === source.store && destination.namespace === source.namespace)
      refuse(`${to} is the selected store itself`);
    // A data file that does not load hides its secrets from the move: a problem, which prepare refuses.
    const problems: string[] = [];
    const byName = await inventory(names ?? [], problems);
    const known = [...byName].toSorted(([a], [b]) => a.localeCompare(b));
    const superseded = await supersededAt(destination.store, destination.namespace);
    return endpoint(destination.store, destination.namespace, async (there) => {
      try {
        await there.validate(destination.namespace);
      } catch (error) {
        problems.push(`destination: ${storeError(error) ? error.code : "unavailable"}`);
      }
      if (!there.capabilities.writable || there.capabilities.conditionalWrites === "none")
        problems.push("destination: cannot write values conditionally");
      const items: Item[] = [];
      /** Each OAuth application whose grants need consent again at the destination. */
      const clients = new Map<string, NonNullable<Item["reauthorize"]>>();
      for (const [name, { kind, connections: used, auth }] of known) {
        let location: SecretLocation;
        try {
          location = secrets.location(name);
        } catch {
          continue; // A deployment key without a binding: never a stored value.
        }
        const item: Item = {
          name,
          kind,
          management: location.management,
          action: location.namespace === "" ? "bound" : location.management === "external" ? "external" : "copy",
          sourcePath: location.path,
          destinationPath: location.path,
          connections: [...used].toSorted(),
        };
        items.push(item);
        if (item.action === "bound") continue;
        const value = await stored(() => secrets.store.read({ namespace: source.namespace, path: location.path }));
        if (value) {
          item.bytes = Buffer.byteLength(value.value, "utf8");
          item.sourceVersion = value.version;
        } else if (item.action === "copy") item.action = "missing";
        if (item.action === "copy" && item.bytes! > there.capabilities.maxBytes) problems.push(`${name}: too_large`);
        const problem =
          item.action === "copy" && auth && authenticationStoreProblem(auth, there.capabilities, "sanoma");
        if (problem) problems.push(`${name}: ${problem}`);
        if (item.action !== "copy" && kind !== "oauth-client") continue;
        const theirs = await there
          .read({ namespace: destination.namespace, path: location.path })
          .catch(() => undefined);
        const other = theirs && value && !same(theirs, value) && superseded.get(name) !== theirs.version;
        if (other && kind === "oauth-client") {
          // The destination's own application stays; the grants issued to this one need consent again.
          if (item.action === "copy") item.action = "kept";
          clients.set(name, "client_changed");
        } else if (other && item.action === "copy") problems.push(`${name}: the destination holds another value`);
        else if (!theirs && kind === "oauth-client" && item.management === "external")
          clients.set(name, "client_missing");
      }
      for (const item of items) {
        const client = byName.get(item.name)?.client;
        const why = client && clients.get(client);
        if (why) item.reauthorize = why;
      }
      return {
        source,
        destination,
        capabilities: { source: capabilities(secrets.store), destination: capabilities(there) },
        items,
        problems: [...new Set(problems)],
      };
    });
  }
  async function moveOf(id: string) {
    const database = await db();
    const [[move], items] = await Promise.all([
      database.select().from(secretMoves).where(eq(secretMoves.id, id)),
      database.select().from(secretMoveItems).where(eq(secretMoveItems.moveId, id)),
    ]);
    if (!move) return refuse(`no move ${id}: prepare it first`);
    return { move, items };
  }
  type Move = Awaited<ReturnType<typeof moveOf>>["move"];
  type Row = Awaited<ReturnType<typeof moveOf>>["items"][number];
  const which = (move: Move): "source" | "destination" | "neither" => {
    const now = selected();
    if (now.store === move.destinationStore && now.namespace === move.destinationNamespace) return "destination";
    if (now.store === move.sourceStore && now.namespace === move.sourceNamespace) return "source";
    return "neither";
  };
  const setItem = async (move: string, name: string, values: Partial<typeof secretMoveItems.$inferInsert>) =>
    (await db())
      .update(secretMoveItems)
      .set(values)
      .where(and(eq(secretMoveItems.moveId, move), eq(secretMoveItems.name, name)));
  /** The move's row changed while it is still under way, or a refusal: a cancel in between wins. */
  async function whileActive(id: string, values: Partial<typeof secretMoves.$inferInsert>) {
    const [row] = await (
      await db()
    )
      .update(secretMoves)
      .set(values)
      .where(and(eq(secretMoves.id, id), inArray(secretMoves.phase, ACTIVE)))
      .returning({ id: secretMoves.id });
    if (!row) refuse("the move was cancelled meanwhile");
  }
  /** Ends a move that cannot go on, lifting its fence so the source takes writes again, and refuses with why. */
  async function abandon(id: string, why: string): Promise<never> {
    await (
      await db()
    )
      .update(secretMoves)
      .set({ phase: "cancelled", fenced: false })
      .where(and(eq(secretMoves.id, id), inArray(secretMoves.phase, ACTIVE)));
    return refuse(`${why}. The move is cancelled, and the source takes writes again`);
  }
  /** Each copied item as it reads at both ends now: unchanged, or stale (the source moved on, or the copy is not the move's). */
  async function readBack(move: Move, items: readonly Row[], destinationMayMove: boolean) {
    const stale: string[] = [];
    await endpoint(move.sourceStore, move.sourceNamespace, (source) =>
      endpoint(move.destinationStore, move.destinationNamespace, async (destination) => {
        for (const item of items) {
          if (item.action !== "copy" || item.state === "pending") continue;
          const [from, to] = await stored(() =>
            Promise.all([
              source.read({ namespace: move.sourceNamespace, path: item.sourcePath }),
              destination.read({ namespace: move.destinationNamespace, path: item.destinationPath }),
            ]),
          );
          const unchanged =
            from?.version === item.sourceVersion &&
            to !== undefined &&
            (to.version === item.destinationVersion ? same(from, to) : destinationMayMove);
          if (!unchanged) stale.push(item.name);
          const state = unchanged ? "verified" : "stale";
          if (item.state !== state) await setItem(move.id, item.name, { state });
        }
      }),
    );
    return stale;
  }
  /** Moves whose source is `store`/`namespace`, cut over and still fenced: their copied versions there are superseded. */
  async function supersededAt(store: string, namespace: string): Promise<Map<string, string | null>> {
    const rows = await (
      await db()
    )
      .select({ name: secretMoveItems.name, version: secretMoveItems.sourceVersion })
      .from(secretMoveItems)
      .innerJoin(secretMoves, eq(secretMoves.id, secretMoveItems.moveId))
      .where(
        and(
          eq(secretMoves.sourceStore, store),
          eq(secretMoves.sourceNamespace, namespace),
          eq(secretMoves.fenced, true),
          inArray(secretMoves.phase, ["cut_over", "retired"]),
        ),
      );
    return new Map(rows.map((r) => [r.name, r.version]));
  }

  return defineDriver(storeMoveOps, {
    storeMigration: {
      plan: ({ to, names }) => planOf(to, names),

      async prepare({ move: id, to, names, retainHours }, call) {
        const [existing] = await (await db()).select().from(secretMoves).where(eq(secretMoves.id, id));
        if (existing && existing.destinationName !== to) refuse(`${id} moves to ${existing.destinationName}`);
        const plan = await planOf(to, names);
        if (plan.problems.length) refuse(`the destination cannot take these secrets: ${plan.problems.join("; ")}`);
        const checks = await endpoint(plan.destination.store, plan.destination.namespace, async (there) => {
          if (CHECK_NAMESPACE === plan.destination.namespace || CHECK_NAMESPACE === plan.source.namespace)
            refuse(`the namespace ${CHECK_NAMESPACE} is where the destination is checked: name another`);
          const results = await stored(() => checkSecretStore(there, CHECK_NAMESPACE));
          // What the check leaves behind, so a second prepare checks again from nothing.
          for (const path of ["RACE", "REPLACE"]) {
            const left = await there.read({ namespace: CHECK_NAMESPACE, path }).catch(() => undefined);
            if (left && there.capabilities.deletion !== "unsupported")
              await there
                .delete({ namespace: CHECK_NAMESPACE, path }, { expectedVersion: left.version, by: writer(id) })
                .catch(() => {});
          }
          return results;
        });
        const failed = checks.filter((c) => !c.ok).map((c) => c.name);
        if (failed.length) refuse(`the destination failed its checks: ${failed.join(", ")}`);
        if (!existing) {
          await (
            await db()
          ).transaction(async (tx) => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('sanoma.storeMigration'))`);
            const [busy] = await tx
              .select({ id: secretMoves.id })
              .from(secretMoves)
              .where(and(inArray(secretMoves.phase, ACTIVE), ne(secretMoves.id, id)));
            if (busy) refuse(`the move ${busy.id} is under way: finish or cancel it first`);
            await tx
              .insert(secretMoves)
              .values({
                id,
                destinationName: to,
                sourceStore: plan.source.store,
                sourceNamespace: plan.source.namespace,
                destinationStore: plan.destination.store,
                destinationNamespace: plan.destination.namespace,
                phase: "prepared",
                retainHours,
                startedBy: call.principal?.id ?? "sanoma",
              })
              .onConflictDoNothing();
            if (plan.items.length)
              await tx
                .insert(secretMoveItems)
                .values(
                  plan.items.map((item) => ({
                    moveId: id,
                    name: item.name,
                    kind: item.kind,
                    management: item.management,
                    sourcePath: item.sourcePath,
                    destinationPath: item.destinationPath,
                    action: item.action,
                    bytes: item.bytes ?? null,
                    reauthorize: item.reauthorize ?? null,
                    sourceVersion: item.sourceVersion ?? null,
                  })),
                )
                .onConflictDoNothing();
          });
        }
        return {
          move: id,
          copy: plan.items.filter((i) => i.action === "copy").length,
          reauthorize: [...new Set(plan.items.filter((i) => i.reauthorize).flatMap((i) => i.connections))].toSorted(),
          checks,
        };
      },

      async transfer({ move: id }) {
        const { move, items } = await moveOf(id);
        if (!ACTIVE.includes(move.phase)) refuse(`the move is ${move.phase}`);
        if (which(move) !== "source") refuse("the deployed code no longer selects the source: nothing more is copied");
        // Quiesce: from here on the source refuses writers (`configuredSecrets`), so the move is the one writer.
        if (move.fenced) await whileActive(id, { phase: "transferring" });
        else if (
          await (
            await db()
          ).transaction(async (tx) => {
            // An OAuth renewal that has sent its refresh token stores the grant it brings back first:
            // the lock holds off a renewal's `sending` until the fence is in, which it then finds.
            await tx.execute(sql`LOCK TABLE ${connectionRenewals} IN SHARE MODE`);
            // A grant bound elsewhere is never paused; one with no bound location may be here.
            const [inFlight] = await tx
              .select({ id: connectionRenewals.connectionId })
              .from(connectionRenewals)
              .innerJoin(connections, eq(connections.id, connectionRenewals.connectionId))
              .where(
                and(
                  isNotNull(connectionRenewals.sentAt),
                  gt(connectionRenewals.leaseUntil, sql`now()`),
                  sql`coalesce(${connections.location}->>'store', ${move.sourceStore}) = ${move.sourceStore}`,
                  sql`coalesce(${connections.location}->>'namespace', ${move.sourceNamespace}) = ${move.sourceNamespace}`,
                ),
              )
              .limit(1);
            if (inFlight) return true;
            const [row] = await tx
              .update(secretMoves)
              .set({ phase: "transferring", fenced: true })
              .where(and(eq(secretMoves.id, id), inArray(secretMoves.phase, ACTIVE)))
              .returning({ id: secretMoves.id });
            if (!row) refuse("the move was cancelled meanwhile");
            return false;
          })
        )
          return { copied: [], unchanged: 0, missing: [], renewing: true };
        const superseded = await supersededAt(move.destinationStore, move.destinationNamespace);
        const copied: string[] = [],
          missing: string[] = [],
          conflicts: string[] = [];
        let unchanged = 0;
        await endpoint(move.sourceStore, move.sourceNamespace, (source) =>
          endpoint(move.destinationStore, move.destinationNamespace, async (destination) => {
            for (const item of items) {
              if (item.action !== "copy") continue;
              const at = { namespace: move.sourceNamespace, path: item.sourcePath };
              const there = { namespace: move.destinationNamespace, path: item.destinationPath };
              const [from, to] = await stored(() => Promise.all([source.read(at), destination.read(there)]));
              if (!from) {
                // Deleted at the source since the plan: nothing to copy, nor to retire.
                await setItem(id, item.name, { action: "missing", sourceVersion: null });
                missing.push(item.name);
                continue;
              }
              if (to && to.version === item.destinationVersion && from.version === item.sourceVersion) {
                unchanged++;
                continue;
              }
              // Replace only what the move wrote, or a copy an earlier move left behind there; adopt an equal value.
              const ours =
                !to ||
                to.version === item.destinationVersion ||
                to.updatedBy === writer(id) ||
                superseded.get(item.name) === to.version;
              if (!ours && same(from, to)) {
                await setItem(id, item.name, {
                  sourceVersion: from.version,
                  destinationVersion: to.version,
                  state: "copied",
                });
                unchanged++;
                continue;
              }
              if (!ours) {
                conflicts.push(item.name);
                continue;
              }
              const written = await stored(() =>
                destination.write(there, from.value, { expectedVersion: to?.version ?? null, by: writer(id) }),
              );
              await setItem(id, item.name, {
                sourceVersion: from.version,
                destinationVersion: written.version,
                bytes: Buffer.byteLength(from.value, "utf8"),
                state: "copied",
              });
              copied.push(item.name);
            }
          }),
        );
        if (conflicts.length)
          await abandon(
            id,
            `the destination holds other values for ${conflicts.join(", ")}, which the move did not write: resolve them there, then move again`,
          );
        return { copied, unchanged, missing, renewing: false };
      },

      async verify({ move: id }) {
        const { move, items } = await moveOf(id);
        const selection = which(move);
        if (move.phase === "cancelled") return { next: "cancelled" as const, stale: [], selected: selection };
        if (!ACTIVE.includes(move.phase)) refuse(`the move is ${move.phase}`);
        const stale = await readBack(move, items, selection === "destination");
        const pending = items.filter((i) => i.action === "copy" && i.state === "pending").map((i) => i.name);
        if (stale.length || pending.length) {
          if (selection !== "source")
            await abandon(
              id,
              `the deployed code selects ${selection === "destination" ? "the destination" : "another store"} while ${[...stale, ...pending].join(", ")} changed at the source: switch back and move again, or reconnect them`,
            );
          await whileActive(id, { phase: "transferring" });
          return { next: "transfer" as const, stale: [...stale, ...pending], selected: selection };
        }
        await whileActive(id, { phase: "verified" });
        return {
          next: selection === "destination" ? ("cutover" as const) : ("wait" as const),
          stale: [],
          selected: selection,
        };
      },

      async cutover({ move: id }) {
        const { move, items } = await moveOf(id);
        const flagged = items.filter((i) => i.reauthorize).map((i) => i.name);
        const reauthorize = flagged.length
          ? (
              await (
                await db()
              )
                .select({ id: connections.id })
                .from(connections)
                .where(inArray(connections.credential, flagged))
            )
              .map((c) => c.id)
              .toSorted()
          : [];
        // Connections follow their credentials to the new location; again on a retry, which finds the rest.
        const done = async (m: Move) => ({
          cutoverAt: m.cutoverAt!.getTime(),
          retainUntil: m.retainUntil!.getTime(),
          rebound: await registry.rebindMoved({ store: m.sourceStore, namespace: m.sourceNamespace }),
          reauthorize,
        });
        if (move.phase === "cut_over" || move.phase === "retired") return done(move);
        if (move.phase !== "verified") refuse(`the move is ${move.phase}: verify it first`);
        if (which(move) !== "destination")
          refuse("the deployed code still selects the source: switch `secrets` to the destination, then cut over");
        const stale = await readBack(move, items, true);
        if (stale.length)
          await abandon(id, `${stale.join(", ")} changed at the source after the copy: switch back and move again`);
        const [cut] = await (
          await db()
        ).transaction(async (tx) => {
          // Cutting over to a store an earlier move left lifts that move's fence: it is the store written again.
          await tx
            .update(secretMoves)
            .set({ fenced: false })
            .where(
              and(
                eq(secretMoves.sourceStore, move.destinationStore),
                eq(secretMoves.sourceNamespace, move.destinationNamespace),
                ne(secretMoves.id, id),
              ),
            );
          return tx
            .update(secretMoves)
            .set({
              phase: "cut_over",
              cutoverAt: sql`now()`,
              retainUntil: sql`now() + make_interval(hours => ${move.retainHours})`,
            })
            .where(and(eq(secretMoves.id, id), eq(secretMoves.phase, "verified")))
            .returning();
        });
        if (!cut) return refuse("the move was cancelled meanwhile");
        return done(cut);
      },

      async retire({ move: id }) {
        const { move, items } = await moveOf(id);
        if (move.phase === "cut_over") {
          if (which(move) !== "destination") refuse("the deployed code no longer selects the destination");
          // The database's clock, which set the window: a worker's a moment behind it waits and retries.
          const { rows } = await (
            await db()
          ).execute<{ open: boolean }>(
            sql`SELECT ${secretMoves.retainUntil} > now() AS open FROM ${secretMoves} WHERE ${secretMoves.id} = ${id}`,
          );
          if (rows[0]?.open)
            throw new DriverError(`Store move: the rollback window lasts until ${move.retainUntil!.toISOString()}`, {
              retryable: true,
            });
        } else if (move.phase !== "retired") refuse(`the move is ${move.phase}: cut it over first`);
        const deletion = await endpoint(move.sourceStore, move.sourceNamespace, async (source) => {
          if (move.phase === "retired") return source.capabilities.deletion;
          for (const item of items) {
            if (!["copy", "kept"].includes(item.action) || item.management !== "sanoma" || item.state === "retired")
              continue;
            const at = { namespace: move.sourceNamespace, path: item.sourcePath };
            let state: MoveItemState = "retained";
            if (source.capabilities.deletion !== "unsupported") {
              const now = await stored(() => source.read(at));
              state = !now || now.version === item.sourceVersion ? "retired" : "retained";
              // Its sanitized code alone; a conflict (changed since) keeps it.
              const deleted =
                !now ||
                state !== "retired" ||
                (await stored(() =>
                  secretStoreCall(() =>
                    source.delete(at, { expectedVersion: item.sourceVersion!, by: writer(id) }),
                  ).then(
                    () => true,
                    (error: SecretStoreError) => {
                      if (error.code === "conflict") return false;
                      throw error;
                    },
                  ),
                ));
              if (!deleted) state = "retained";
            }
            await setItem(id, item.name, { state });
          }
          await (
            await db()
          )
            .update(secretMoves)
            .set({ phase: "retired", retiredAt: sql`now()` })
            .where(eq(secretMoves.id, id));
          return source.capabilities.deletion;
        });
        const after = (await moveOf(id)).items;
        return {
          retired: after.filter((i) => i.state === "retired").map((i) => i.name),
          retained: after
            .filter((i) => i.action === "external" || (["copy", "kept"].includes(i.action) && i.state !== "retired"))
            .map((i) => ({
              name: i.name,
              why:
                i.action === "external"
                  ? ("external" as const)
                  : deletion === "unsupported"
                    ? ("unsupported" as const)
                    : ("changed" as const),
            })),
          deletion,
          vendorRevocation: "not_performed" as const,
        };
      },

      async cancel({ move: id }) {
        const { move, items } = await moveOf(id);
        if (move.phase !== "cancelled") {
          if (!ACTIVE.includes(move.phase)) refuse(`the move is ${move.phase}: move back to the source instead`);
          if (which(move) === "destination")
            refuse(
              "the deployed code selects the destination already: the move cuts over; switch the code back first to cancel",
            );
          const [cancelled] = await (
            await db()
          )
            .update(secretMoves)
            .set({ phase: "cancelled", fenced: false })
            .where(and(eq(secretMoves.id, id), inArray(secretMoves.phase, ACTIVE)))
            .returning({ id: secretMoves.id });
          if (!cancelled) refuse("the move changed: read it again");
        }
        return {
          phase: "cancelled" as const,
          atDestination: items
            .filter((i) => i.destinationVersion)
            .map((i) => i.name)
            .toSorted(),
        };
      },
    },
  });
}

/** A move as the app shows it: the move's row and its items' receipts, never a value. */
export interface StoreMove {
  id: string;
  destinationName: string;
  source: { store: string; namespace: string };
  destination: { store: string; namespace: string };
  phase: MovePhase;
  fenced: boolean;
  retainHours: number;
  startedBy: string;
  createdAt: string;
  cutoverAt?: string;
  retainUntil?: string;
  retiredAt?: string;
  items: {
    name: string;
    kind: MoveItemKind;
    management: "sanoma" | "external";
    action: MoveItemAction;
    bytes?: number;
    state: MoveItemState;
    reauthorize?: "client_changed" | "client_missing";
  }[];
}

/** The latest moves, newest first, with their items (`SanomaClient.storeMoves`). */
export async function readStoreMoves(db: Db, limit = 10): Promise<StoreMove[]> {
  const moves = await db
    .select()
    .from(secretMoves)
    .orderBy(sql`${secretMoves.createdAt} DESC`)
    .limit(limit);
  if (!moves.length) return [];
  const items = await db
    .select()
    .from(secretMoveItems)
    .where(
      inArray(
        secretMoveItems.moveId,
        moves.map((m) => m.id),
      ),
    );
  return moves.map((m) => ({
    id: m.id,
    destinationName: m.destinationName,
    source: { store: m.sourceStore, namespace: m.sourceNamespace },
    destination: { store: m.destinationStore, namespace: m.destinationNamespace },
    phase: m.phase,
    fenced: m.fenced,
    retainHours: m.retainHours,
    startedBy: m.startedBy,
    createdAt: m.createdAt.toISOString(),
    ...(m.cutoverAt && { cutoverAt: m.cutoverAt.toISOString() }),
    ...(m.retainUntil && { retainUntil: m.retainUntil.toISOString() }),
    ...(m.retiredAt && { retiredAt: m.retiredAt.toISOString() }),
    items: items
      .filter((i) => i.moveId === m.id)
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((i) => ({
        name: i.name,
        kind: i.kind,
        management: i.management,
        action: i.action,
        ...(i.bytes !== null && { bytes: i.bytes }),
        state: i.state,
        ...(i.reauthorize && { reauthorize: i.reauthorize }),
      })),
  }));
}
