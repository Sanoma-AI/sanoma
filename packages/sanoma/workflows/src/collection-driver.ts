import * as drizzle from "drizzle-orm";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  answer,
  type Batch,
  type Collection,
  collectionsConnector,
  type Conflict,
  conflictOf,
  type DataOps,
  type DeleteInput,
  jsonTypesOf,
  type KeysByCollection,
  linkedKeys,
  linksMissing,
  linksOf,
  type Listing,
  missingLinks,
  recordChanged,
  recordExists,
  recordsChanged,
  recordsOps,
  type SaveInput,
  updatedBy,
} from "./collection.ts";
import type { Db } from "./db.ts";
import { data } from "./db/company.ts";
import { isObject } from "./resource.ts";
import { type CallContext, defineDriver, type Driver, type DriverImpl } from "./op.ts";
import { BATCH, type Deleted, linksIn, linkTarget, reshape } from "./shared.ts";

// The collections' driver: their records as rows of the `data` table, in the config's database,
// and `sanoma.records.reshape`'s. Apart from `collection.ts`, which declares them and fakes them in
// memory with no database.

const COLUMNS = { key: data.key, record: data.record, updatedAt: data.updatedAt, updatedBy: data.updatedBy };
// By namespace: the fake names a range's bounds `gt`, `gte`, `lt` and `lte`.
const RANGE = { gt: drizzle.gt, gte: drizzle.gte, lt: drizzle.lt, lte: drizzle.lte };

type Row = Pick<typeof data.$inferSelect, keyof typeof COLUMNS>;

/**
 * The collections' driver: their records in the `data` table of the database `store` is on, through
 * the pool a run's calls share, or one connection in a transaction (a direct write, with its
 * ledger record). Every value reaches Postgres as a parameter, field names included; the field
 * names and operators are the ones the input's schema accepts.
 */
export function collectionsDriver(list: readonly Collection[], store: { db(): Promise<Db> }): Driver {
  const impl = list.map((c) => {
    const linked = linksOf(c).length > 0;
    const saved = (row: Row, found?: KeysByCollection) =>
      answer(
        c,
        { key: row.key, record: row.record, updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy },
        found,
      );
    /** The rows as `get` and `list` answer them: a link to a record that is not there among their issues. */
    const answered = async (db: Db, rows: Row[]) => {
      const found = linked
        ? await foundOn(
            db,
            linkedKeys(
              c,
              rows.map((row) => row.record),
            ),
          )
        : undefined;
      return rows.map((row) => saved(row, found));
    };
    /**
     * Refuses the records just written on `db`, in the save's transaction, when a link names a
     * record that is not there; the records it names are locked (`for key share`) until it ends,
     * so none is deleted under it.
     */
    const checkLinks = async (db: Db, written: readonly Record<string, unknown>[]) => {
      const missing = missingLinks(c, written, await foundOn(db, linkedKeys(c, written), true));
      if (missing.length) throw linksMissing(missing);
    };
    const here = (key: string) => and(eq(data.collection, c.name), eq(data.key, key));
    /** The record on `db`, as `get` answers it and a refused save or delete carries it (`current`). */
    const getOn = async (db: Db, key: string) => {
      const [row] = await db.select(COLUMNS).from(data).where(here(key));
      return row ? saved(row) : null;
    };
    /** One save on `db`, as `save` makes it and a batch makes each of its records. */
    const saveOn = async (db: Db, { record, ifAbsent, ifRecord }: SaveInput, by: string) => {
      const key = record[c.key] as string;
      if (ifRecord !== undefined) {
        // PostgreSQL locks and rechecks the predicate on a concurrent update. A lost-response
        // retry may recover its own identical result, but never overwrite another actor's state.
        const retry = and(eq(data.record, record), eq(data.updatedBy, by))!;
        const [row] = await db
          .update(data)
          .set({ record, updatedAt: sql`CASE WHEN ${retry} THEN ${data.updatedAt} ELSE now() END`, updatedBy: by })
          .where(and(here(key), or(eq(data.record, ifRecord), retry)))
          .returning(COLUMNS);
        if (row) return saved(row);
        throw recordChanged(await getOn(db, key));
      }
      // The conflict row is locked by Postgres: never implement an insert-only claim as get + save.
      // An identical retry by the same actor keeps the first receipt and never overwrites later progress.
      const conflict = ifAbsent
        ? { set: { record: sql`${data.record}` }, setWhere: and(eq(data.record, record), eq(data.updatedBy, by)) }
        : { set: { record, updatedAt: sql`now()`, updatedBy: by } };
      const [row] = await db
        .insert(data)
        .values({ collection: c.name, key, record, updatedBy: by })
        .onConflictDoUpdate({ target: [data.collection, data.key], ...conflict })
        .returning(COLUMNS);
      if (row) return saved(row);
      const current = await getOn(db, key);
      // Gone between the refusal and this read: what refused it was a record, so it has changed since.
      throw current ? recordExists(current) : recordChanged(null);
    };
    /**
     * One delete on `db`, as `delete` makes it and a batch makes each of its deletes. A retry
     * (`attempt` past the first) that finds no record under `ifRecord` deleted it the first time,
     * and its answer was lost: nothing is left to recover a receipt from, so it is deleted.
     */
    const deleteOn = async (db: Db, { key, ifRecord }: DeleteInput, retrying: boolean): Promise<Deleted> => {
      const gone = await db
        .delete(data)
        .where(ifRecord === undefined ? here(key) : and(here(key), eq(data.record, ifRecord)))
        .returning({ key: data.key });
      if (gone.length || ifRecord === undefined) return { key, deleted: gone.length > 0 };
      const current = await getOn(db, key);
      if (current === null && retrying) return { key, deleted: true };
      throw recordChanged(current);
    };
    const ops: Record<string, (input: any, call: CallContext) => Promise<unknown>> = {
      get: async ({ key }: { key: string }) => {
        const db = await store.db();
        const rows = await db.select(COLUMNS).from(data).where(here(key));
        return (await answered(db, rows))[0] ?? null;
      },
      list: async (listing: Listing) => {
        const { where, order } = listClauses(c, listing);
        const db = await store.db();
        const rows = await db
          .select(COLUMNS)
          .from(data)
          .where(where)
          .orderBy(...order)
          .limit(listing.limit);
        return answered(db, rows);
      },
      count: async (counting: Pick<Listing, "where">) => {
        const [row] = await (
          await store.db()
        )
          .select({ count: drizzle.count() })
          .from(data)
          .where(listClauses(c, counting).where);
        return { count: row!.count };
      },
      save: async (input: SaveInput, call) => {
        const db = await store.db();
        if (!linked) return saveOn(db, input, updatedBy(call));
        return db.transaction(async (tx) => {
          const receipt = await saveOn(tx, input, updatedBy(call));
          await checkLinks(tx, [input.record]);
          return receipt;
        });
      },
      // One transaction: a conflict on any entry, collected so each is answered, rolls back them all.
      [BATCH]: async ({ records, deletes }: Batch, call) =>
        (await store.db()).transaction(async (tx) => {
          const by = updatedBy(call);
          const results: unknown[] = [];
          const conflicts: Conflict[] = [];
          const made = async (key: string, entry: Promise<unknown>) => {
            try {
              results.push(await entry);
            } catch (err) {
              conflicts.push(conflictOf(key, err));
            }
          };
          for (const e of records) await made(e.record[c.key] as string, saveOn(tx, e, by));
          for (const e of deletes) await made(e.key, deleteOn(tx, e, call.attempt > 1));
          if (conflicts.length) throw recordsChanged(conflicts);
          // After every entry: a record the batch saves may be one another links to.
          if (linked)
            await checkLinks(
              tx,
              records.map((e) => e.record),
            );
          return results;
        }),
      delete: async (input: DeleteInput, call) => deleteOn(await store.db(), input, call.attempt > 1),
    };
    return [c.name, ops];
  });
  return defineDriver(collectionsConnector(list), Object.fromEntries(impl) as DriverImpl<DataOps>);
}

/**
 * The keys among `wanted` (by collection) that have a record on `db`, by collection: one statement
 * for them all, locking those rows against a delete (`for key share`) when `lock` says so.
 */
async function foundOn(db: Db, wanted: KeysByCollection, lock = false): Promise<KeysByCollection> {
  const found: KeysByCollection = new Map();
  if (!wanted.size) return found;
  const where = or(
    ...[...wanted].map(([collection, keys]) => and(eq(data.collection, collection), inArray(data.key, [...keys]))),
  );
  const query = db.select({ collection: data.collection, key: data.key }).from(data).where(where);
  for (const row of await (lock ? query.for("key share") : query)) {
    found.set(row.collection, (found.get(row.collection) ?? new Set()).add(row.key));
  }
  return found;
}

/** How many records one statement of a reshape updates. */
const RESHAPE_CHUNK = 500;

/**
 * `sanoma.records.reshape`'s driver, on the `data` table of the database `db` opens: in one
 * transaction, the collection's rows read and locked (`for update`), each brought along by
 * `reshape` (`shared.ts`, the one rule the app's counts use too), and only the rows that changed
 * written back, `RESHAPE_CHUNK` a statement, saved now by the call's actor (`updatedBy`). From the
 * input's names and types alone: the declaration the worker loaded may still be the one before.
 */
export function recordsDriver(db: () => Promise<Db>): Driver {
  return defineDriver(recordsOps, {
    records: {
      reshape: async ({ collection, changes }, call) =>
        (await db()).transaction(async (tx) => {
          const rows = await tx
            .select({ key: data.key, record: data.record })
            .from(data)
            .where(eq(data.collection, collection))
            .orderBy(data.key)
            .for("update");
          // A retype or a conversion to a link matches the values against the keys it links to.
          const keys = new Map<string, Set<string>>();
          for (const link of linksIn(changes)) {
            const target = linkTarget(collection, link);
            const there = await tx.select({ key: data.key }).from(data).where(eq(data.collection, target));
            keys.set(link, new Set(there.map((row) => row.key)));
          }
          const { changed, counts } = reshape(
            rows.map((row) => row.record),
            changes,
            keys,
          );
          const updates = [...changed].map(([i, record]) => ({ key: rows[i]!.key, record }));
          const by = updatedBy(call);
          for (let at = 0; at < updates.length; at += RESHAPE_CHUNK) {
            // The rows as one JSON parameter, read back as a table to join on.
            const chunk = JSON.stringify(updates.slice(at, at + RESHAPE_CHUNK));
            await tx.execute(sql`
              UPDATE ${data} SET record = v.record, updated_at = now(), updated_by = ${by}
              FROM jsonb_to_recordset(${chunk}::jsonb) AS v(key text, record jsonb)
              WHERE ${data.collection} = ${collection} AND ${data.key} = v.key`);
          }
          return counts;
        }),
    },
  });
}

const SQL_TYPE = { string: "text", number: "numeric", boolean: "boolean" } as const;

/**
 * The `list` query's filter and order on Postgres. A field's value is compared as its declared
 * type, text byte by byte (`COLLATE "C"`, whatever the database's collation, as the fake
 * compares it); a missing value, or one of another type, is SQL's null: it matches no filter and
 * sorts last.
 */
function listClauses(
  c: Collection,
  { where = {}, order }: Pick<Listing, "where" | "order">,
): { where: SQL | undefined; order: SQL[] } {
  const types = jsonTypesOf(c);
  const field = (name: string) => {
    const type = types[name]!;
    const sqlType = sql.raw(SQL_TYPE[type]);
    const json = sql`${data.record} -> ${name}::text`;
    const typed = sql`CASE WHEN jsonb_typeof(${json}) = ${type} THEN (${json} #>> '{}')::${sqlType} END`;
    return type === "string" ? sql`(${typed}) COLLATE "C"` : typed;
  };
  const value = (name: string, v: unknown) => sql`${v}::${sql.raw(SQL_TYPE[types[name]!])}`;
  const conditions: SQL[] = [eq(data.collection, c.name)];
  for (const [name, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (!isObject(condition)) conditions.push(eq(field(name), value(name, condition)));
    else {
      for (const [op, v] of Object.entries(condition)) {
        if (v !== undefined) conditions.push(RANGE[op as keyof typeof RANGE](field(name), value(name, v)));
      }
    }
  }
  const byKey = sql`${data.key} COLLATE "C"`;
  const by =
    order === undefined
      ? [byKey]
      : [sql`${field(order.replace(/^-/, ""))} ${sql.raw(order.startsWith("-") ? "DESC" : "ASC")} NULLS LAST`, byKey];
  return { where: and(...conditions), order: by };
}
