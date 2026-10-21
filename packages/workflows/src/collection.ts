import { z } from "zod";
import { DATA_TABLE, type LazyPool } from "./db.ts";
import { defineFake, type Fake } from "./fake.ts";
import { isObject } from "./resource.ts";
import {
  type CallContext,
  type Connector,
  defineConnector,
  defineDriver,
  type Driver,
  type DriverImpl,
  type Op,
  type OpSpec,
} from "./op.ts";
import { checkCollection, DATA_VENDOR, type FIELD_TYPES, type ListQuery, type Saved } from "./shared.ts";

// A company's own records: a collection is declared with plain values (a name, a key and typed
// fields), and its `get`, `list`, `save` and `delete` are operations of the vendor `data`, under
// the policy and in the ledger like any connector's. The records are JSON rows of one table the
// runtime owns (`DATA_TABLE`), in the config's database; a sandbox run keeps them in memory.

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

/** A collection, as `collection()` declares it, with its four operations. */
export interface Collection<
  N extends string = string,
  F extends Record<string, Field> = Record<string, Field>,
  K extends string = string,
> {
  readonly [COLLECTION]: true;
  readonly kind: "collection";
  readonly name: N;
  readonly key: K;
  readonly fields: F;
  readonly title?: string;
  readonly get: Op<typeof DATA_VENDOR, N, "get", { key: string }, Saved<RecordOf<F>> | null>;
  readonly list: Op<typeof DATA_VENDOR, N, "list", ListQuery<RecordOf<F>>, Saved<RecordOf<F>>[]>;
  readonly save: Op<typeof DATA_VENDOR, N, "save", { record: RecordOf<F> }, Saved<RecordOf<F>>>;
  readonly delete: Op<typeof DATA_VENDOR, N, "delete", { key: string }, { deleted: boolean }>;
}

/**
 * Declares a collection of records, in `resources/data.ts`:
 * `collection({ name: "outbound", key: "company", fields: { company: "text", stage: { enum: ["new", "won"] } } })`.
 * Its operations are `data.<name>.get`, `.list`, `.save` and `.delete`, which a workflow names in
 * `uses` and calls on `ctx.data.<name>`. The name is a lowercase letter then letters and digits;
 * the key is a required text field, each record's own and unique.
 */
export function collection<
  const N extends string,
  const F extends Record<string, Field>,
  const K extends RequiredTextKeys<F>,
>(declaration: { name: N; key: K; fields: F; title?: string }): Collection<N, F, K> {
  checkCollection(declaration);
  const { name, key, fields, title } = declaration;
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
    key,
    fields,
    ...(title !== undefined && { title }),
    ...ops,
  }) as unknown as Collection<N, F, K>;
}

/** A date or a date and time with its offset, as ISO 8601 writes them. */
const DATE = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

/** The schema of a field's value, required. */
function valueSchema(kind: Field): z.ZodType {
  if (typeof kind === "object" && "enum" in kind) return z.enum(kind.enum);
  const type = typeof kind === "string" ? kind : kind.type;
  return { text: z.string(), person: z.string().min(1), date: DATE, number: z.number(), boolean: z.boolean() }[type];
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

/** A collection's four operations, for `defineConnector`. */
function specsOf(name: string, key: string, fields: Record<string, Field>, record: z.ZodType): Record<string, OpSpec> {
  const at = (k: string) => `${DATA_VENDOR}:${name}/${k}`;
  const byKey = z.object({ key: z.string().min(1) });
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
      input: byKey,
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
        limit: z.number().int().min(1).max(1000).default(100),
      }),
      output: z.array(SAVED),
      target: () => `${DATA_VENDOR}:${name}`,
    },
    save: {
      effect: "write",
      idempotent: true,
      description: `Save a record of ${name}: added, or replacing the one with its ${key}`,
      input: z.object({ record }),
      output: SAVED,
      target: ({ record: r }: { record: Record<string, string> }) => at(r[key]!),
    },
    delete: {
      effect: "write",
      idempotent: true,
      description: `Delete the record of ${name} with this ${key}`,
      input: byKey,
      output: z.object({ deleted: z.boolean() }),
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
  const ops = list.map((c) => [c.name, { get: c.get, list: c.list, save: c.save, delete: c.delete }]);
  return { ...defineConnector(DATA_VENDOR, {}), ...Object.fromEntries(ops) } as Connector<typeof DATA_VENDOR, DataOps>;
}

const COLUMNS = "key, record, updated_at, updated_by";
const RANGE = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

interface Row {
  key: string;
  record: Record<string, unknown>;
  updated_at: Date;
  updated_by: string;
}

/** A `list` input as its schema parses it. */
interface Listing {
  where?: Record<string, unknown>;
  order?: string;
  limit: number;
}

/**
 * The collections' driver: their records in `DATA_TABLE` of the database `pool` is on. Every
 * value reaches Postgres as a parameter, field names included; the field names and operators
 * are the ones the input's schema accepts.
 */
export function collectionsDriver(list: readonly Collection[], pool: LazyPool): Driver {
  const query = async (sql: string, params: unknown[]) => (await pool.db()).query<Row>(sql, params);
  const impl = list.map((c) => {
    const saved = (row: Row) =>
      answer(c, {
        key: row.key,
        record: row.record,
        updatedAt: row.updated_at.toISOString(),
        updatedBy: row.updated_by,
      });
    const ops: Record<string, (input: any, call: CallContext) => Promise<unknown>> = {
      get: async ({ key }: { key: string }) => {
        const sql = `SELECT ${COLUMNS} FROM ${DATA_TABLE} WHERE collection = $1 AND key = $2`;
        const [row] = (await query(sql, [c.name, key])).rows;
        return row ? saved(row) : null;
      },
      list: async (listing: Listing) => (await query(...listSql(c, listing))).rows.map(saved),
      save: async ({ record }: { record: Record<string, unknown> }, call) => {
        const sql =
          `INSERT INTO ${DATA_TABLE} (collection, key, record, updated_by) VALUES ($1, $2, $3, $4) ` +
          "ON CONFLICT (collection, key) DO UPDATE SET record = EXCLUDED.record, updated_at = now(), " +
          `updated_by = EXCLUDED.updated_by RETURNING ${COLUMNS}`;
        const params = [c.name, record[c.key], JSON.stringify(record), updatedBy(call)];
        return saved((await query(sql, params)).rows[0]!);
      },
      delete: async ({ key }: { key: string }) => {
        const sql = `DELETE FROM ${DATA_TABLE} WHERE collection = $1 AND key = $2`;
        return { deleted: ((await query(sql, [c.name, key])).rowCount ?? 0) > 0 };
      },
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
 * The `list` query on Postgres, and its parameters. A field's value is compared as its declared
 * type, text byte by byte (`COLLATE "C"`, whatever the database's collation, as the fake
 * compares it); a missing value, or one of another type, is SQL's null: it matches no filter and
 * sorts last.
 */
function listSql(c: Collection, { where = {}, order, limit }: Listing): [string, unknown[]] {
  const types = jsonTypesOf(c);
  const params: unknown[] = [c.name];
  const param = (value: unknown) => `$${params.push(value)}`;
  const field = (name: string) => {
    const type = types[name]!;
    const json = `record -> ${param(name)}::text`;
    const typed = `CASE WHEN jsonb_typeof(${json}) = '${type}' THEN (${json} #>> '{}')::${SQL_TYPE[type]} END`;
    return type === "string" ? `(${typed}) COLLATE "C"` : typed;
  };
  const value = (name: string, v: unknown) => `${param(v)}::${SQL_TYPE[types[name]!]}`;
  const conditions = ["collection = $1"];
  for (const [name, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (!isObject(condition)) conditions.push(`${field(name)} = ${value(name, condition)}`);
    else {
      for (const [op, v] of Object.entries(condition)) {
        const sign = RANGE[op as keyof typeof RANGE];
        if (v !== undefined) conditions.push(`${field(name)} ${sign} ${value(name, v)}`);
      }
    }
  }
  const byKey = `key COLLATE "C"`;
  const by =
    order === undefined
      ? byKey
      : `${field(order.replace(/^-/, ""))} ${order.startsWith("-") ? "DESC" : "ASC"} NULLS LAST, ${byKey}`;
  const sql = `SELECT ${COLUMNS} FROM ${DATA_TABLE} WHERE ${conditions.join(" AND ")} ORDER BY ${by} LIMIT ${param(limit)}`;
  return [sql, params];
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
          const ops: Record<string, (input: any, call: CallContext) => Promise<unknown>> = {
            get: async ({ key }: { key: string }) => (Object.hasOwn(records(), key) ? saved(records()[key]!) : null),
            list: async ({ where = {}, order, limit }: Listing) =>
              Object.values(records())
                .filter((s) => matches(s.record, where, types))
                .toSorted(byOrder(order, types))
                .slice(0, limit)
                .map(saved),
            save: async ({ record }: { record: Record<string, unknown> }, call) => {
              const key = record[c.key] as string;
              const stored = {
                key,
                record: structuredClone(record),
                updatedAt: new Date().toISOString(),
                updatedBy: updatedBy(call),
              };
              records()[key] = stored;
              return saved(stored);
            },
            delete: async ({ key }: { key: string }) => {
              const had = Object.hasOwn(records(), key);
              delete records()[key];
              return { deleted: had };
            },
          };
          return [c.name, ops];
        }),
      ) as DriverImpl<DataOps>,
  });
}
