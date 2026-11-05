import type { UIMessage, UIMessageChunk } from "ai";
import type { Pool } from "pg";
import { CHAT_CHUNKS_TABLE as CHUNKS, CHAT_MESSAGES_TABLE as MESSAGES, CHATS_TABLE as CHATS } from "./db.ts";
import { SanomaError } from "./errors.ts";

// The operator agent's chats, in the config's database beside the runtime's other tables: one row
// per chat (whose it is, the engine it runs on, the draft it edits, the turn last begun), its
// messages as the AI SDK's UI messages, and the reply its turn streams, as chunks. A turn is a run
// of `chat` the worker executes: it writes the transcript and the chunks, which the app reads. A
// worker's restart does not run a turn again: the transcript and the draft's branch are what it
// keeps, and the person sends "continue".

/** A chat as `SanomaClient.chats.list` reads it. */
export interface Chat {
  id: string;
  /** Whose chat it is: the principal's id. Nobody else reads or continues it. */
  person: string;
  /** What runs its turns: `"loop"`, the app's own loop, or another engine the app knows. */
  engine: string;
  /** The draft it edits (`Source.draft`), once its first edit opened one. */
  draftId?: string;
  title: string;
  /** When it was opened, in milliseconds since the epoch. */
  createdAt: number;
}

/** The chats' store, `SanomaClient.chats`. */
export interface Chats {
  /**
   * Opens the chat `id` (the browser's) for `person` on `engine`, titled `title`. An id another
   * chat has is refused (`invalid_input`).
   */
  open(chat: { id: string; person: string; engine: string; title: string }): Promise<void>;
  /** Records the draft the chat edits. */
  attach(id: string, draftId: string): Promise<void>;
  /**
   * Writes these messages of the chat, each by its id: a message already there is replaced in its
   * place, a new one goes after the rest, in the order given.
   */
  upsert(id: string, messages: readonly UIMessage[]): Promise<void>;
  /** The chat's messages in order; none for a chat that has none. */
  load(id: string): Promise<UIMessage[]>;
  /** The chat `id`, or undefined when there is none. */
  get(id: string): Promise<Chat | undefined>;
  /** The person's chats, the newest first: the latest 50. */
  list(person: string): Promise<Chat[]>;
  /**
   * Begins the turn `turn` (its run's id) of the chat `id`: false when it had begun already (the
   * worker restarted under it). The chunks of the chat's other turns go.
   */
  begin(id: string, turn: string): Promise<boolean>;
  /** Writes these chunks of the reply the turn `turn` of the chat `id` streams, after those written. */
  append(id: string, turn: string, chunks: readonly UIMessageChunk[]): Promise<void>;
  /** Ends the turn's stream: nothing is appended after it. */
  end(id: string, turn: string): Promise<void>;
  /** The turn's chunks after the one numbered `after` (0 for all), the last one's number, and whether its stream has ended. */
  chunks(turn: string, after: number): Promise<{ chunks: UIMessageChunk[]; last: number; ended: boolean }>;
}

/** A row of the chats' table. */
interface ChatRow {
  id: string;
  person: string;
  engine: string;
  draft_id: string | null;
  title: string;
  created_at: Date;
}

const COLUMNS = "id, person, engine, draft_id, title, created_at";

const chatOf = ({ draft_id, created_at, ...row }: ChatRow): Chat => ({
  ...row,
  ...(draft_id === null ? {} : { draftId: draft_id }),
  createdAt: created_at.getTime(),
});

/** The chats' store on the pool `db` gives, the config's database once it is prepared. */
export function chatStore(db: () => Promise<Pool>): Chats {
  return {
    async open({ id, person, engine, title }) {
      const { rows } = await (
        await db()
      ).query(
        `INSERT INTO ${CHATS} (id, person, engine, title) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, person, engine, title],
      );
      if (!rows.length) throw new SanomaError("invalid_input", `Chat ${id} exists already; open it with another id`);
    },
    async attach(id, draftId) {
      await (await db()).query(`UPDATE ${CHATS} SET draft_id = $2 WHERE id = $1`, [id, draftId]);
    },
    async upsert(id, messages) {
      if (!messages.length) return;
      if (messages.some((m) => !m.id)) throw new SanomaError("invalid_input", "A chat message needs an id");
      // A new message's place is after the chat's last, in the order given.
      await (
        await db()
      ).query(
        `INSERT INTO ${MESSAGES} (chat_id, id, seq, message) ` +
          `SELECT $1, m.value->>'id', last.seq + m.n, m.value ` +
          `FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS m (value, n), ` +
          `(SELECT coalesce(max(seq), 0) AS seq FROM ${MESSAGES} WHERE chat_id = $1) AS last ` +
          "ON CONFLICT (chat_id, id) DO UPDATE SET message = EXCLUDED.message",
        [id, JSON.stringify(messages)],
      );
    },
    async load(id) {
      const { rows } = await (
        await db()
      ).query<{ message: UIMessage }>(`SELECT message FROM ${MESSAGES} WHERE chat_id = $1 ORDER BY seq, id`, [id]);
      return rows.map((row) => row.message);
    },
    async get(id) {
      const { rows } = await (await db()).query<ChatRow>(`SELECT ${COLUMNS} FROM ${CHATS} WHERE id = $1`, [id]);
      return rows[0] && chatOf(rows[0]);
    },
    async begin(id, turn) {
      const pool = await db();
      const { rows } = await pool.query(
        `UPDATE ${CHATS} SET turn = $2 WHERE id = $1 AND turn IS DISTINCT FROM $2 RETURNING id`,
        [id, turn],
      );
      await pool.query(`DELETE FROM ${CHUNKS} WHERE chat_id = $1 AND run_id <> $2`, [id, turn]);
      return rows.length > 0;
    },
    async append(id, turn, chunks) {
      if (chunks.length) await appendChunks(await db(), id, turn, chunks);
    },
    async end(id, turn) {
      await appendChunks(await db(), id, turn, [null]);
    },
    async chunks(turn, after) {
      const { rows } = await (
        await db()
      ).query<{ seq: number; chunk: UIMessageChunk | null }>(
        `SELECT seq, chunk FROM ${CHUNKS} WHERE run_id = $1 AND seq > $2 ORDER BY seq`,
        [turn, after],
      );
      const ended = rows.at(-1)?.chunk === null;
      return {
        chunks: rows.flatMap((row) => (row.chunk === null ? [] : [row.chunk])),
        last: rows.at(-1)?.seq ?? after,
        ended,
      };
    },
    async list(person) {
      const { rows } = await (
        await db()
      ).query<ChatRow>(`SELECT ${COLUMNS} FROM ${CHATS} WHERE person = $1 ORDER BY created_at DESC, id LIMIT 50`, [
        person,
      ]);
      return rows.map(chatOf);
    },
  };
}

/** Writes `chunks` (null, the end) after the turn's last, in the order given. */
async function appendChunks(pool: Pool, id: string, turn: string, chunks: readonly (UIMessageChunk | null)[]) {
  await pool.query(
    `INSERT INTO ${CHUNKS} (chat_id, run_id, seq, chunk) ` +
      "SELECT $1, $2, last.seq + c.n, nullif(c.value, 'null') " +
      "FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS c (value, n), " +
      `(SELECT coalesce(max(seq), 0) AS seq FROM ${CHUNKS} WHERE run_id = $2) AS last`,
    [id, turn, JSON.stringify(chunks)],
  );
}
