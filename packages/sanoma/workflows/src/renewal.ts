import { randomUUID } from "node:crypto";
import { and, eq, gt, isNotNull, notExists, sql } from "drizzle-orm";
import type { AuthenticationProblem, OAuthFlow, OAuthGrant } from "./authentication.ts";
import type { Db } from "./db.ts";
import { connectionRenewals, connections, secretMoves } from "./db/company.ts";
import type { DeadlineRegistry } from "./deadlines.ts";
import { warn } from "./log.ts";
import { errorMessage } from "./shared.ts";

// The renewal of each OAuth connection's grant, coordinated across processes by a lease in
// Postgres (`sanoma_connection_renewals`): one process at a time holds a connection's lease, for
// `LEASE_MS`, while it reads the grant, sends its refresh token and writes the new grant with the
// version it read (the store's expected-version write, the fence against any other writer). Before
// the request goes out the holder marks the lease `sentAt`, so a process that finds the lease
// lapsed after that knows a refresh token may have been spent with nothing stored, and marks the
// connection `uncertain` rather than send it again. A grant renews on use: when a call finds it
// near its expiry, or the provider rejected it. Only for a flow that declares how long its refresh
// token lasts (`refreshTokenLifetime`) is a renewal scheduled too, so a grant nobody uses keeps a
// live refresh token: its due time is a row, which a worker registers as a deadline with its
// wakeup (`renewWhenDue`), never a timer that keeps it up. Without one, an idle instance is never woken.

/** How a connection's last renewal ended: `refreshed`, or the problem it met. */
export type RenewalOutcome = "refreshed" | AuthenticationProblem;

/** How long one process holds a connection's lease: the token request's 30 s, the store's write, and room. */
export const LEASE_MS = 60_000;
/** How long before a grant expires a call renews it. */
export const RENEW_AHEAD_MS = 5 * 60_000;
/** How long a due renewal the worker took waits before it is taken again, should it end with no answer. */
const RETRY_MS = 5 * 60_000;

/** True when a call should renew `grant` first: it has a refresh token and expires within `RENEW_AHEAD_MS`. */
export const renewalDue = (grant: OAuthGrant): boolean =>
  grant.refreshToken !== undefined && grant.expiresAt !== undefined && grant.expiresAt - Date.now() <= RENEW_AHEAD_MS;

/**
 * When the worker renews a grant just stored, should no call renew it first: with a tenth of its
 * refresh token's lifetime left (`refreshTokenLifetime`). None for a flow that declares no lifetime.
 */
export const renewalDueAt = (flow: OAuthFlow, grant: OAuthGrant): Date | null =>
  flow.refreshTokenLifetime !== undefined && grant.refreshToken !== undefined
    ? new Date(Date.now() + flow.refreshTokenLifetime * 900)
    : null;

/**
 * A connection's lease, taken: `holder` fences every write under it. `abandoned` when the lease
 * this one replaced had lapsed after its holder sent a refresh token: whether the provider issued
 * a grant for it is not known.
 */
export interface Lease {
  holder: string;
  abandoned: boolean;
}

/** A connection's renewal as its card shows it: metadata only. */
export interface RenewalState {
  refreshedAt?: string;
  outcome?: RenewalOutcome;
  dueAt?: string;
}

/** A renewal row's state, from its columns (null where it has none). */
export const renewalState = (r: {
  refreshedAt: Date | null;
  outcome: RenewalOutcome | null;
  dueAt: Date | null;
}): RenewalState => ({
  ...(r.refreshedAt && { refreshedAt: r.refreshedAt.toISOString() }),
  ...(r.outcome && { outcome: r.outcome }),
  ...(r.dueAt && { dueAt: r.dueAt.toISOString() }),
});

/** The renewal rows of one company's database. */
export class ConnectionRenewals {
  private readonly db: () => Promise<Db>;
  constructor(db: () => Promise<Db>) {
    this.db = db;
  }

  /** The lease on connection `id`, taken when nobody holds it or its holder's lapsed; undefined while another holds it. */
  async take(id: string): Promise<Lease | undefined> {
    return (await this.db()).transaction(async (tx) => {
      await tx.insert(connectionRenewals).values({ connectionId: id }).onConflictDoNothing();
      const [row] = await tx
        .select({
          holder: connectionRenewals.holder,
          held: sql<boolean>`coalesce(${connectionRenewals.leaseUntil} > now(), false)`,
          sent: sql<boolean>`${connectionRenewals.sentAt} is not null`,
        })
        .from(connectionRenewals)
        .where(eq(connectionRenewals.connectionId, id))
        .for("update");
      if (row!.holder !== null && row!.held) return undefined;
      const holder = randomUUID();
      await tx
        .update(connectionRenewals)
        .set({ holder, leaseUntil: sql`now() + make_interval(secs => ${LEASE_MS / 1000})`, sentAt: null })
        .where(eq(connectionRenewals.connectionId, id));
      return { holder, abandoned: row!.holder !== null && row!.sent };
    });
  }

  /**
   * Marks the lease's request as about to be sent, its `LEASE_MS` counted from now: false when the
   * lease lapsed (and so may be another's), or when a store move has paused writes where the grant
   * lives (`at`, see `writesPaused`), so its successor could not be kept. A move's transfer locks
   * these rows while it pauses them and waits out a request already sent (`store-move.ts`).
   */
  async sending(id: string, holder: string, at: { store: string; namespace: string }): Promise<boolean> {
    const [marked] = await (
      await this.db()
    )
      .update(connectionRenewals)
      .set({ sentAt: sql`now()`, leaseUntil: sql`now() + make_interval(secs => ${LEASE_MS / 1000})` })
      .where(
        and(
          eq(connectionRenewals.connectionId, id),
          eq(connectionRenewals.holder, holder),
          gt(connectionRenewals.leaseUntil, sql`now()`),
          notExists(
            sql`(SELECT 1 FROM ${secretMoves} WHERE ${secretMoves.sourceStore} = ${at.store} AND ${secretMoves.sourceNamespace} = ${at.namespace} AND ${secretMoves.fenced})`,
          ),
        ),
      )
      .returning({ id: connectionRenewals.connectionId });
    return marked !== undefined;
  }

  /**
   * Gives the lease up, recording what it did: `outcome` (and `refreshedAt` now, for `refreshed`;
   * null for a new grant, its renewal history cleared) and the next due time (`dueAt`, null for
   * none); each kept when left out. A lease that lapsed and was taken is not this one's to give up.
   */
  async release(
    id: string,
    holder: string,
    record: { outcome?: RenewalOutcome | null; dueAt?: Date | null } = {},
  ): Promise<void> {
    await (
      await this.db()
    )
      .update(connectionRenewals)
      .set({
        holder: null,
        leaseUntil: null,
        sentAt: null,
        ...(record.outcome !== undefined && { outcome: record.outcome }),
        ...(record.outcome === "refreshed" && { refreshedAt: sql`now()` }),
        ...(record.outcome === null && { refreshedAt: null }),
        ...(record.dueAt !== undefined && { dueAt: record.dueAt }),
      })
      .where(and(eq(connectionRenewals.connectionId, id), eq(connectionRenewals.holder, holder)));
  }

  /** Forgets a connection's renewal (a disconnect): a lease held on it is lost, and so its holder's writes. */
  async forget(id: string): Promise<void> {
    await (await this.db()).delete(connectionRenewals).where(eq(connectionRenewals.connectionId, id));
  }

  /** Schedules no further renewal for connection `id`: the policy refused the worker's. Use renews it again. */
  async unschedule(id: string): Promise<void> {
    await (
      await this.db()
    )
      .update(connectionRenewals)
      .set({ dueAt: null })
      .where(eq(connectionRenewals.connectionId, id));
  }

  /** Connection `id`'s renewal: none before its first lease. */
  async state(id: string): Promise<RenewalState | undefined> {
    const [row] = await (
      await this.db()
    )
      .select()
      .from(connectionRenewals)
      .where(eq(connectionRenewals.connectionId, id));
    return row && renewalState(row);
  }

  /**
   * The connected connection whose renewal is due first, taken for `RETRY_MS` (its due time moved
   * on, so another worker's look or this one's next does not take it again while it renews), with
   * the due time it had. One at a time, so a renewal is taken only when it is about to be made.
   */
  async takeDue(): Promise<{ id: string; vendor: string; dueAt: Date } | undefined> {
    const taken = await (
      await this.db()
    ).execute<{ id: string; vendor: string; due_at: string }>(sql`
      WITH due AS (
        SELECT r.connection_id, r.due_at FROM ${connectionRenewals} r
        JOIN ${connections} c ON c.id = r.connection_id AND c.status = 'connected'
        WHERE r.due_at <= now()
        ORDER BY r.due_at
        LIMIT 1
        FOR UPDATE OF r SKIP LOCKED
      )
      UPDATE ${connectionRenewals} r SET due_at = now() + make_interval(secs => ${RETRY_MS / 1000})
      FROM due JOIN ${connections} c ON c.id = due.connection_id
      WHERE r.connection_id = due.connection_id
      RETURNING r.connection_id AS id, c.vendor, due.due_at`);
    const [row] = taken.rows;
    return row && { id: row.id, vendor: row.vendor, dueAt: new Date(row.due_at) };
  }

  /** The earliest renewal due of a connected connection: the worker's deadline. */
  async nextDue(): Promise<Date | undefined> {
    const [row] = await (
      await this.db()
    )
      .select({ at: sql<string | null>`min(${connectionRenewals.dueAt})` })
      .from(connectionRenewals)
      .innerJoin(
        connections,
        and(eq(connections.id, connectionRenewals.connectionId), eq(connections.status, "connected")),
      )
      .where(isNotNull(connectionRenewals.dueAt));
    return row?.at ? new Date(row.at) : undefined;
  }
}

/** What `renewWhenDue` needs of a worker. */
export interface RenewWhenDue {
  renewals: ConnectionRenewals;
  deadlines: DeadlineRegistry;
  /** Renews one due connection: the runtime's `renewal` agent's call of `sanoma.connection.refresh`. */
  renew(due: { id: string; vendor: string; dueAt: Date }): Promise<void>;
}

/**
 * The worker's renewals: the earliest due one is a deadline source (`addSource`), so a worker that
 * stops when quiet registers it with its wakeup and the next worker renews it; while the worker
 * runs, an unref'd timer looks again at that time (at least every minute, for a grant another
 * process stored), renews what is due, counted busy while it does. `close` ends the looks, once
 * the one under way is done: a refresh token sent is never cut off from its write.
 */
export function renewWhenDue({ renewals, deadlines, renew }: RenewWhenDue): { close(): Promise<void> } {
  let next: Date | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let looking: Promise<void> | undefined;
  deadlines.addSource(() => next);
  const look = () => (looking = looked().finally(() => (looking = undefined)));
  const looked = async () => {
    timer = undefined;
    try {
      for (;;) {
        // `close` may come while a renewal runs: the next is not taken.
        const due = closed ? undefined : await renewals.takeDue();
        if (!due) break;
        await deadlines
          .running(`renewal:${due.id}`, () => renew(due))
          .catch((err: unknown) => warn(`could not renew the connection ${due.id}: ${errorMessage(err)}`));
      }
      next = await renewals.nextDue();
    } catch (err) {
      warn(`could not look for connections to renew: ${errorMessage(err)}`);
    }
    if (closed) return;
    const wait = Math.min(Math.max((next?.getTime() ?? Infinity) - Date.now(), 1_000), 60_000);
    timer = setTimeout(() => void look(), wait);
    timer.unref();
  };
  void look();
  return {
    async close() {
      closed = true;
      clearTimeout(timer);
      await looking;
    },
  };
}
