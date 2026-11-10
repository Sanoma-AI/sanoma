import * as drizzle from "drizzle-orm";
import { and, eq, or, sql, type SQL } from "drizzle-orm";
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
  type Listing,
  recordChanged,
  recordExists,
  recordsChanged,
  type SaveInput,
  updatedBy,
} from "./collection.ts";
import type { Db } from "./db.ts";
import { data } from "./db/company.ts";
import { isObject } from "./resource.ts";
import { type CallContext, defineDriver, type Driver, type DriverImpl } from "./op.ts";
import { BATCH, type Deleted } from "./shared.ts";

// The collections' driver: their records as rows of the `data` table, in the config's database.
// Apart from `collection.ts`, which declares them and fakes them in memory with no database.

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
    const saved = (row: Row) =>
      answer(c, {
        key: row.key,
        record: row.record,
        updatedAt: row.updatedAt.toISOString(),
        updatedBy: row.updatedBy,
      });
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
      get: async ({ key }: { key: string }) => getOn(await store.db(), key),
      list: async (listing: Listing) => {
        const { where, order } = listClauses(c, listing);
        const rows = await (
          await store.db()
        )
          .select(COLUMNS)
          .from(data)
          .where(where)
          .orderBy(...order)
          .limit(listing.limit);
        return rows.map(saved);
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
      save: async (input: SaveInput, call) => saveOn(await store.db(), input, updatedBy(call)),
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
          return results;
        }),
      delete: async (input: DeleteInput, call) => deleteOn(await store.db(), input, call.attempt > 1),
    };
    return [c.name, ops];
  });
  return defineDriver(collectionsConnector(list), Object.fromEntries(impl) as DriverImpl<DataOps>);
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
