import { Client, escapeIdentifier } from "pg";

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
 * sentinel }`: each `text`, `varchar`, `char`, `json` and `jsonb` column (and array of them) of
 * every table in every schema but Postgres's own (`pg_*`, `information_schema`). A test expects
 * none: `expect(await findSentinels(url, sentinels)).toEqual([])` fails naming each table and
 * column. A sentinel is 12 characters or more of letters, digits and `_ . : ~ + / = -` (a UUID's
 * or a base64 key's characters), which JSON writes as they are; another is refused. Bytes (`bytea`) are not
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
    const { rows: columns } = await db.query<{ schema: string; table: string; column: string }>(`
      SELECT c.table_schema AS schema, c.table_name AS table, c.column_name AS column
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE t.table_type = 'BASE TABLE'
        AND c.table_schema <> 'information_schema' AND c.table_schema NOT LIKE 'pg\\_%'
        AND (c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb')
          OR (c.data_type = 'ARRAY' AND c.udt_name IN ('_text', '_varchar', '_bpchar', '_json', '_jsonb')))
      ORDER BY 1, 2, 3`);
    const hits: SentinelHit[] = [];
    for (const { schema, table, column } of columns) {
      const { rows } = await db.query<{ sentinel: string }>(
        `SELECT s AS sentinel FROM unnest($1::text[]) s WHERE EXISTS (
           SELECT 1 FROM ${escapeIdentifier(schema)}.${escapeIdentifier(table)}
           WHERE strpos(${escapeIdentifier(column)}::text, s) > 0)`,
        [planted],
      );
      for (const { sentinel } of rows) hits.push({ schema, table, column, sentinel });
    }
    return hits;
  } finally {
    await db.end();
  }
}
