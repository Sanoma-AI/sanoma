import { Client, escapeIdentifier, escapeLiteral } from "pg";

// Finding a planted secret wherever a database keeps text (`findSentinels`).

/** A column that holds a sentinel: where a secret reached. */
export interface SentinelHit {
  schema: string;
  table: string;
  column: string;
  sentinel: string;
}

/** What a sentinel may be made of: nothing JSON escapes, so a column's text holds it as written. */
const SENTINEL = /^[\w.:~+/=-]{12,}$/;

/**
 * Every column of `url`'s database that holds one of `sentinels`, as `{ schema, table, column,
 * sentinel }`: each column of a string, JSON, XML, array, composite or other non-numeric type
 * (`text`, `varchar`, `citext`, `jsonb` and the like, read as text), of every table in every schema
 * but Postgres's own (`pg_*`, `information_schema`), found through the catalog, so a table the role
 * cannot read fails rather than being left out. A test expects none:
 * `expect(await findSentinels(url, sentinels)).toEqual([])` fails naming each table and column. A
 * sentinel is 12 characters or more of letters, digits and `_ . : ~ + / = -` (a UUID's or a base64
 * key's characters), which JSON writes as they are; another is refused. Bytes (`bytea`) are not
 * read: a sealed value is expected there.
 */
export async function findSentinels(url: string, sentinels: Iterable<string>): Promise<SentinelHit[]> {
  const planted = [...new Set(sentinels)];
  const unfit = planted.find((s) => !SENTINEL.test(s));
  if (unfit !== undefined)
    throw new Error(`Not a sentinel findSentinels can find as written: ${JSON.stringify(unfit)}`);
  if (!planted.length) return [];
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const { rows: tables } = await db.query<{ schema: string; table: string; columns: string[] }>(`
      SELECT n.nspname AS schema, c.relname AS table, array_agg(a.attname::text ORDER BY a.attnum) AS columns
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      JOIN pg_type t ON t.oid = a.atttypid
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
        AND t.typcategory IN ('S', 'U', 'A', 'C', 'E') AND t.typname NOT IN ('bytea', '_bytea')
      GROUP BY 1, 2
      ORDER BY 1, 2`);
    const hits: SentinelHit[] = [];
    // One scan of each table: each row's columns as text, against each sentinel.
    for (const { schema, table, columns } of tables) {
      const values = columns.map((c) => `(${escapeLiteral(c)}, t.${escapeIdentifier(c)}::text)`).join(", ");
      const { rows } = await db.query<{ column: string; sentinel: string }>(
        `SELECT DISTINCT v.col AS column, s AS sentinel
         FROM ${escapeIdentifier(schema)}.${escapeIdentifier(table)} t
         CROSS JOIN LATERAL (VALUES ${values}) AS v(col, val)
         JOIN unnest($1::text[]) s ON strpos(v.val, s) > 0
         ORDER BY 1, 2`,
        [planted],
      );
      for (const { column, sentinel } of rows) hits.push({ schema, table, column, sentinel });
    }
    return hits;
  } finally {
    await db.end();
  }
}
