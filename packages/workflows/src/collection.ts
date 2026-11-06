import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import * as drizzle from "drizzle-orm";
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "./db.ts";
import { data } from "./db/company.ts";
import { vendorCodeOf } from "./errors.ts";
import { defineFake, type Fake } from "./fake.ts";
import { isObject } from "./resource.ts";
import {
  type CallContext,
  type Connector,
  defineConnector,
  defineDriver,
  DriverError,
  type Driver,
  type DriverImpl,
  type Op,
  type OpSpec,
} from "./op.ts";
import { callerFile } from "./define.ts";
import { appOfFile } from "./paths.ts";
import {
  BATCH,
  BATCH_LIMIT,
  checkCollection,
  DATA_VENDOR,
  type Deleted,
  type FIELD_TYPES,
  LIST_LIMIT,
  type ListQuery,
  qualified,
  type Saved,
} from "./shared.ts";

// A company's own records: a collection is declared with plain values (a name, a key and typed
// fields), and its `get`, `list`, `count`, `save`, `saveMany` and `delete` are operations of the
// vendor `data`, under the policy and in the ledger like any connector's. The records are JSON
// rows of one table the runtime owns (`data`), in the config's database; a sandbox run keeps
// them in memory.

export type FieldType = (typeof FIELD_TYPES)[number];

/** A field of a collection: its type, the type marked optional, or one of a list of strings. */
export type Field =
  | FieldType
  | { type: FieldType; optional?: true }
  | { enum: readonly [string, ...string[]]; optional?: true };

type ValueOfType<T> = T extends "number" ? number : T extends "boolean" ? boolean : string;
type ValueOf<F> = F extends { enum: readonly (infer E)[] }
  ? E
  : F extends { type: infer T }
    ? ValueOfType<T>
    : ValueOfType<F>;
type OptionalKeys<F> = { [K in keyof F]: F[K] extends { optional: true } ? K : never }[keyof F];
type Flat<T> = { [K in keyof T]: T[K] };

/** A record of a collection with these fields: text, a person and a date are strings, an enum one of its strings. */
export type RecordOf<F extends Record<string, Field>> = Flat<
  { -readonly [K in Exclude<keyof F & string, OptionalKeys<F>>]: ValueOf<F[K]> } & {
    -readonly [K in OptionalKeys<F> & string]?: ValueOf<F[K]>;
  }
>;

/** The fields that may be a collection's key: required text. */
export type RequiredTextKeys<F extends Record<string, Field>> = {
  [K in keyof F & string]: F[K] extends "text" | { type: "text"; optional?: undefined } ? K : never;
}[keyof F & string];

/**
 * Where a collection keeps its brand: a registered symbol, so a copy of this package reads a
 * collection another copy made, as `VENDOR` and `RESOURCE`.
 */
export const COLLECTION: unique symbol = Symbol.for("sanoma.collection");

/** A collection, as `collection()` declares it, with its six operations. */
export interface Collection<
  N extends string = string,
  F extends Record<string, Field> = Record<string, Field>,
  K extends string = string,
> {
  readonly [COLLECTION]: true;
  readonly kind: "collection";
  /** Its name: as written at the root; in an app's folder, `<app>.<name>` (`app`), though its type says the written one. */
  readonly name: N;
  /** The app whose folder declared it (`apps/<app>/resources/data.ts`); absent for one at the root. */
  readonly app?: string;
  readonly key: K;
  readonly fields: F;
  readonly title?: string;
  readonly get: Op<typeof DATA_VENDOR, N, "get", { key: string }, Saved<RecordOf<F>> | null>;
  readonly list: Op<typeof DATA_VENDOR, N, "list", ListQuery<RecordOf<F>>, Saved<RecordOf<F>>[]>;
  readonly count: Op<typeof DATA_VENDOR, N, "count", Pick<ListQuery<RecordOf<F>>, "where">, { count: number }>;
  readonly save: Op<
    typeof DATA_VENDOR,
    N,
    "save",
    { record: RecordOf<F>; ifAbsent?: boolean; ifRecord?: Record<string, unknown> },
    Saved<RecordOf<F>>
  >;
  readonly saveMany: Op<
    typeof DATA_VENDOR,
    N,
    "saveMany",
    {
      records?: { record: RecordOf<F>; ifAbsent?: boolean; ifRecord?: Record<string, unknown> }[];
      deletes?: { key: string; ifRecord?: Record<string, unknown> }[];
    },
    (Saved<RecordOf<F>> | Deleted)[]
  >;
  readonly delete: Op<typeof DATA_VENDOR, N, "delete", { key: string; ifRecord?: Record<string, unknown> }, Deleted>;
}

/**
 * Declares a collection of records, in `resources/data.ts`:
 * `collection({ name: "outbound", key: "company", fields: { company: "text", stage: { enum: ["new", "won"] } } })`.
 * Its operations are `data.<name>.get`, `.list`, `.count`, `.save`, `.saveMany` and `.delete`,
 * which a workflow names in `uses` and calls on `ctx.data.<name>`. The name is a lowercase letter then letters and digits;
 * the key is a required text field, each record's own and unique. In an app's folder
 * (`apps/<app>/resources/data.ts`) the runtime names it `<app>.<name>`: `data.<app>.<name>.get`,
 * called on `ctx.data.<app>.<name>`.
 */
export function collection<
  const N extends string,
  const F extends Record<string, Field>,
  const K extends RequiredTextKeys<F>,
>(declaration: { name: N; key: K; fields: F; title?: string }): Collection<N, F, K> {
  // Frame 2 of `callerFile` is this function's caller: the data file.
  return collectionIn(appOfFile(callerFile()), declaration);
}

/** `collection()` in the app `app` names (none for the root's): what the loader's `collection` calls, knowing the file itself. */
export function collectionIn<
  const N extends string,
  const F extends Record<string, Field>,
  const K extends RequiredTextKeys<F>,
>(app: string | undefined, declaration: { name: N; key: K; fields: F; title?: string }): Collection<N, F, K> {
  checkCollection(declaration);
  const { key, fields, title } = declaration;
  const name = qualified(app, declaration.name);
  const record = z.strictObject(
    Object.fromEntries(
      Object.entries(fields).map(([field, kind]) => {
        const value = field === key ? z.string().min(1) : valueSchema(kind);
        return [field, isObject(kind) && kind.optional ? value.optional() : value];
      }),
    ),
  );
  const ops = defineConnector(DATA_VENDOR, { [name]: specsOf(name, key, fields, record) })[name]!;
  return Object.freeze({
    [COLLECTION]: true,
    kind: "collection",
    name,
    ...(app && { app }),
    key,
    fields,
    ...(title !== undefined && { title }),
    ...ops,
  }) as unknown as Collection<N, F, K>;
}

/**
 * A date or a date and time with its offset, as ISO 8601 writes them, marked `format: "date"` in
 * its JSON Schema (beside the union's own), which a form reads to draw a date's input.
 */
const DATE = z.union([z.iso.date(), z.iso.datetime({ offset: true })]).meta({ format: "date" });

/**
 * A person's id: text that is not empty, marked `format: "person"` in its JSON Schema, which a form
 * reads to draw a person's input.
 */
const PERSON = z.string().min(1).meta({ format: "person" });

/** The schema of a field's value, required. */
function valueSchema(kind: Field): z.ZodType {
  if (typeof kind === "object" && "enum" in kind) return z.enum(kind.enum);
  const type = typeof kind === "string" ? kind : kind.type;
  return { text: z.string(), person: PERSON, date: DATE, number: z.number(), boolean: z.boolean() }[type];
}

/**
 * What `get`, `list` and `save` answer: the record as it is stored, which an older declaration
 * may have accepted, so it is not checked here; `issues` say where the fields refuse it.
 */
const SAVED = z.object({
  key: z.string(),
  record: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
  updatedBy: z.string(),
  issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })).optional(),
});

/** What `delete` answers, and a batch for each of its deletes: whether there was a record to delete. */
const DELETED = z.object({ key: z.string(), deleted: z.boolean() });

/** A collection's six operations, for `defineConnector`. */
function specsOf(name: string, key: string, fields: Record<string, Field>, record: z.ZodType): Record<string, OpSpec> {
  const at = (k: string) => `${DATA_VENDOR}:${name}/${k}`;
  const whole = `${DATA_VENDOR}:${name}`;
  const ifRecord = z.record(z.string(), z.unknown()).optional();
  const byKey = z.object({ key: z.string().min(1), ifRecord });
  /** What `save` takes, and a batch for each of its records. */
  const saving = z
    .object({ record, ifAbsent: z.boolean().optional(), ifRecord })
    .refine((input) => !(input.ifAbsent && input.ifRecord !== undefined), {
      message: "Choose ifAbsent or ifRecord, not both",
    });
  const names = Object.keys(fields);
  const where = z.strictObject(
    Object.fromEntries(
      Object.entries(fields).map(([field, kind]) => {
        const value = valueSchema(kind);
        const range = z.strictObject({ gt: value, gte: value, lt: value, lte: value }).partial();
        return [field, z.union([value, range]).optional()];
      }),
    ),
  );
  return {
    get: {
      effect: "read",
      idempotent: true,
      description: `Get a record of ${name} by its ${key}`,
      input: z.object({ key: z.string().min(1) }),
      output: SAVED.nullable(),
      target: ({ key: k }: { key: string }) => at(k),
    },
    list: {
      effect: "read",
      idempotent: true,
      description: `List records of ${name}: fields equal to a value or within a range, sorted, at most \`limit\``,
      input: z.object({
        where: where.optional(),
        order: z.enum([...names, ...names.map((n) => `-${n}`)] as [string, ...string[]]).optional(),
        limit: z.number().int().min(1).max(LIST_LIMIT.max).default(LIST_LIMIT.default),
      }),
      output: z.array(SAVED),
      target: () => whole,
    },
    count: {
      effect: "read",
      idempotent: true,
      description: `Count the records of ${name}, or those with fields equal to a value or within a range`,
      input: z.object({ where: where.optional() }),
      output: z.object({ count: z.number().int() }),
      target: () => whole,
    },
    save: {
      effect: "write",
      idempotent: true,
      description: `Save a record of ${name}: added, or replacing the one with its ${key}; ifAbsent refuses a different existing record`,
      input: saving,
      output: SAVED,
      target: ({ record: r }: { record: Record<string, string> }) => at(r[key]!),
    },
    [BATCH]: {
      effect: "write",
      idempotent: true,
      description: `Save and delete records of ${name} together, all or none, each entry decided and recorded as its own save or delete`,
      input: z
        .object({
          records: z.array(saving).default([]),
          deletes: z.array(byKey).default([]),
        })
        .superRefine((batch, ctx) => {
          const keys = [
            ...batch.records.map((e) => (e.record as Record<string, string>)[key]!),
            ...batch.deletes.map((e) => e.key),
          ];
          if (keys.length < 1 || keys.length > BATCH_LIMIT) {
            ctx.addIssue({ code: "custom", message: `A batch has 1 to ${BATCH_LIMIT} entries` });
          }
          if (new Set(keys).size !== keys.length) {
            ctx.addIssue({ code: "custom", message: `A batch names each ${key} once` });
          }
        }),
      output: z.array(z.union([SAVED, DELETED])),
      target: () => whole,
    },
    delete: {
      effect: "write",
      idempotent: true,
      description: `Delete the record of ${name} with this ${key}; ifRecord refuses a changed or missing one`,
      input: byKey,
      output: DELETED,
      target: ({ key: k }: { key: string }) => at(k),
    },
  };
}

/** True for a collection `collection()` made, in this copy of the package or another: read by its brand. */
export const isCollection = (x: unknown): x is Collection =>
  isObject(x) && (x as Partial<Collection>)[COLLECTION] === true && x.kind === "collection";

/** The schema a collection's records are saved under: its fields, and nothing else. */
export const recordSchemaOf = (c: Collection): z.ZodType =>
  (c.save.input as unknown as z.ZodObject<{ record: z.ZodType }>).shape.record;

/** Where the record no longer fits the collection's fields, as `Saved.issues` says it; none when it fits. */
export function recordIssues(c: Collection, record: unknown): NonNullable<Saved["issues"]> {
  const parsed = recordSchemaOf(c).safeParse(record);
  if (parsed.success) return [];
  return parsed.error.issues.map(({ path, message }) => ({
    path: path.filter((p): p is string | number => typeof p !== "symbol"),
    message,
  }));
}

type Stored = Omit<Saved, "issues">;
type DataOps = Record<string, Record<string, OpSpec>>;

/** The record as `get`, `list` and `save` answer it: with its issues, when it has any. */
function answer(c: Collection, stored: Stored): Saved {
  const issues = recordIssues(c, stored.record);
  return issues.length ? { ...stored, issues } : stored;
}

/** Who a save is by: the person a direct call is made as, else the run. */
const updatedBy = (call: CallContext) => call.by ?? `run:${call.runId}`;

/** The vendor `data` as a connector of the collections' operations, the very ones each `collection()` made. */
export function collectionsConnector(list: readonly Collection[]): Connector<typeof DATA_VENDOR, DataOps> {
  const ops = list.map((c) => [
    c.name,
    { get: c.get, list: c.list, count: c.count, save: c.save, [BATCH]: c.saveMany, delete: c.delete },
  ]);
  return { ...defineConnector(DATA_VENDOR, {}), ...Object.fromEntries(ops) } as Connector<typeof DATA_VENDOR, DataOps>;
}

const COLUMNS = { key: data.key, record: data.record, updatedAt: data.updatedAt, updatedBy: data.updatedBy };
/** The refusal of an `ifAbsent` save, carrying the record that is there (`current`). */
const recordExists = (current: Saved) =>
  Object.assign(
    new DriverError("Collection record already exists", { retryable: false, status: 409, vendorCode: "record_exists" }),
    { current },
  );
/** The refusal of an `ifRecord` save or delete, carrying the record as it stands (`current`), or `null` when it is gone. */
const recordChanged = (current: Saved | null) =>
  Object.assign(
    new DriverError(current ? "Collection record changed" : "Collection record is missing", {
      retryable: false,
      status: 409,
      vendorCode: "record_changed",
    }),
    { current },
  );
/** An entry of a batch its `ifRecord` refused: its key, and the record as it stands, or `null` when it is gone. */
export type Conflict = { key: string; current: Saved | null };
/** The refusal of a batch, carrying every entry refused (`conflicts`), with the record as each stands. */
const recordsChanged = (conflicts: Conflict[]) =>
  Object.assign(
    new DriverError(`${conflicts.length} of the batch's records changed or are missing`, {
      retryable: false,
      status: 409,
      vendorCode: "record_changed",
    }),
    { conflicts },
  );
/** The refusal of one entry (its `ifRecord` or `ifAbsent`), as a batch collects it; any other failure is the batch's. */
const conflictOf = (key: string, err: unknown): Conflict => {
  const code = vendorCodeOf(err);
  if (code !== "record_changed" && code !== "record_exists") throw err;
  return { key, current: (err as { current: Saved | null }).current };
};
const sameJson = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
type SaveInput = { record: Record<string, unknown>; ifAbsent?: boolean; ifRecord?: Record<string, unknown> };
type DeleteInput = { key: string; ifRecord?: Record<string, unknown> };
/** A `saveMany` input as its schema parses it. */
type Batch = { records: SaveInput[]; deletes: DeleteInput[] };
// By namespace: the fake names a range's bounds `gt`, `gte`, `lt` and `lte`.
const RANGE = { gt: drizzle.gt, gte: drizzle.gte, lt: drizzle.lt, lte: drizzle.lte };

type Row = Pick<typeof data.$inferSelect, keyof typeof COLUMNS>;

/** A `list` input as its schema parses it. */
interface Listing {
  where?: Record<string, unknown>;
  order?: string;
  limit: number;
}

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

/** What a field's values are in JSON: `number`, `boolean`, or a `string` (text, a date, a person, an enum value). */
type JsonType = "string" | "number" | "boolean";

/** Each field's `JsonType`, by name: what `list` compares its values as. */
const jsonTypesOf = (c: Collection): Record<string, JsonType> =>
  Object.fromEntries(
    Object.entries(c.fields).map(([name, kind]) => {
      const type = typeof kind === "string" ? kind : "type" in kind ? kind.type : "text";
      return [name, type === "number" || type === "boolean" ? type : "string"];
    }),
  );

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

/** Orders two values of one type as Postgres does under `COLLATE "C"`: strings by their UTF-8 bytes. */
const compare = (a: unknown, b: unknown): number =>
  typeof a === "string" && typeof b === "string"
    ? Buffer.compare(Buffer.from(a), Buffer.from(b))
    : (a as number) < (b as number)
      ? -1
      : (a as number) > (b as number)
        ? 1
        : 0;

/** The record's value of a field when it is of the field's type; none otherwise, as for a missing one. */
const valueIn = (record: Record<string, unknown>, name: string, type: JsonType | undefined) =>
  typeof record[name] === type ? record[name] : undefined;

/** Whether the record meets each condition of `where`, as the driver's SQL decides it. */
function matches(record: Record<string, unknown>, where: Record<string, unknown>, types: Record<string, JsonType>) {
  return Object.entries(where).every(([name, condition]) => {
    if (condition === undefined) return true;
    const value = valueIn(record, name, types[name]);
    if (value === undefined) return false;
    if (!isObject(condition)) return compare(value, condition) === 0;
    const { gt, gte, lt, lte } = condition;
    return (
      (gt === undefined || compare(value, gt) > 0) &&
      (gte === undefined || compare(value, gte) >= 0) &&
      (lt === undefined || compare(value, lt) < 0) &&
      (lte === undefined || compare(value, lte) <= 0)
    );
  });
}

const byKey = (a: Stored, b: Stored) => compare(a.key, b.key);

/** Sorts as the driver's SQL does: by the field (missing last), then by key; by key alone without one. */
function byOrder(order: string | undefined, types: Record<string, JsonType>): (a: Stored, b: Stored) => number {
  if (order === undefined) return byKey;
  const name = order.replace(/^-/, "");
  const sign = order.startsWith("-") ? -1 : 1;
  return (a, b) => {
    const x = valueIn(a.record, name, types[name]);
    const y = valueIn(b.record, name, types[name]);
    if ((x === undefined) !== (y === undefined)) return x === undefined ? 1 : -1;
    return (x === undefined ? 0 : sign * compare(x, y)) || byKey(a, b);
  };
}

/** The collections' records in memory, by collection and key: what a sandbox run's fake holds. */
export type CollectionsState = Record<string, Record<string, Stored>>;

/**
 * An in-memory fake of the collections' driver, which starts empty: a scenario seeds it
 * (`Given data.<name> "<key>" has`), and a test may through `update`.
 */
export function collectionsFake(list: readonly Collection[]): Fake<CollectionsState> {
  return defineFake(collectionsConnector(list), {
    // Null-prototype records, so any key is a record's own, `__proto__` too, as it is in Postgres.
    initial: (): CollectionsState => Object.fromEntries(list.map((c) => [c.name, Object.create(null)])),
    ops: (state) =>
      Object.fromEntries(
        list.map((c) => {
          const records = () => state[c.name]!;
          const types = jsonTypesOf(c);
          const saved = (stored: Stored) => answer(c, structuredClone(stored));
          const stored = (key: string) => (Object.hasOwn(records(), key) ? records()[key] : undefined);
          const matching = (where: Record<string, unknown> = {}) =>
            Object.values(records()).filter((s) => matches(s.record, where, types));
          const save = ({ record, ifAbsent, ifRecord }: SaveInput, by: string) => {
            const key = record[c.key] as string;
            const previous = stored(key);
            if (ifRecord !== undefined) {
              if (!previous) throw recordChanged(null);
              if (previous.updatedBy === by && sameJson(previous.record, record)) return saved(previous);
              if (!sameJson(previous.record, ifRecord)) throw recordChanged(saved(previous));
            }
            if (ifAbsent && previous) {
              // Postgres jsonb ignores property order and omitted undefined fields.
              if (previous.updatedBy !== by || !sameJson(previous.record, record)) throw recordExists(saved(previous));
              return saved(previous);
            }
            const next = { key, record: structuredClone(record), updatedAt: new Date().toISOString(), updatedBy: by };
            records()[key] = next;
            return saved(next);
          };
          const remove = ({ key, ifRecord }: DeleteInput, retrying: boolean): Deleted => {
            const previous = stored(key);
            if (ifRecord !== undefined && !(previous && sameJson(previous.record, ifRecord))) {
              // As the driver: a retry finding no record deleted it the first time.
              if (!previous && retrying) return { key, deleted: true };
              throw recordChanged(previous ? saved(previous) : null);
            }
            delete records()[key];
            return { key, deleted: previous !== undefined };
          };
          const ops: Record<string, (input: any, call: CallContext) => Promise<unknown>> = {
            get: async ({ key }: { key: string }) => {
              const s = stored(key);
              return s ? saved(s) : null;
            },
            list: async ({ where, order, limit }: Listing) =>
              matching(where).toSorted(byOrder(order, types)).slice(0, limit).map(saved),
            count: async ({ where }: Pick<Listing, "where">) => ({ count: matching(where).length }),
            save: async (input: SaveInput, call) => save(input, updatedBy(call)),
            // All or none, as the driver's transaction: a failure puts back every entry made before it.
            [BATCH]: async ({ records: saves, deletes }: Batch, call) => {
              const by = updatedBy(call);
              const results: unknown[] = [];
              const conflicts: Conflict[] = [];
              const before = new Map<string, Stored | undefined>();
              const restore = () => {
                for (const [key, previous] of before) {
                  if (previous) records()[key] = previous;
                  else delete records()[key];
                }
              };
              const made = (key: string, entry: () => unknown) => {
                before.set(key, stored(key));
                try {
                  results.push(entry());
                } catch (err) {
                  conflicts.push(conflictOf(key, err));
                }
              };
              try {
                for (const e of saves) made(e.record[c.key] as string, () => save(e, by));
                for (const e of deletes) made(e.key, () => remove(e, call.attempt > 1));
              } catch (err) {
                restore();
                throw err;
              }
              if (!conflicts.length) return results;
              restore();
              throw recordsChanged(conflicts);
            },
            delete: async (input: DeleteInput, call) => remove(input, call.attempt > 1),
          };
          return [c.name, ops];
        }),
      ) as DriverImpl<DataOps>,
  });
}
