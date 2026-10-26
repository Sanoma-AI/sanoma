import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import type { Pool } from "pg";
import { CHAT_MESSAGES_TABLE as MESSAGES, CHATS_TABLE as CHATS } from "./db.ts";
import { SanomaError } from "./errors.ts";

// The operator agent's chats, in the config's database beside the runtime's other tables: one row
// per chat (whose it is, the engine it runs on, the draft it edits) and its messages as the AI
// SDK's UI messages. The turn itself is not durable: what a restart keeps is this transcript and
// the draft's branch, and the person sends "continue".

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
   * Opens a chat for `person` on `engine`, titled `title`, and returns its id: `id` when given (a
   * browser's chat id), else a new one. An id another chat has is refused (`invalid_input`).
   */
  open(chat: { person: string; engine: string; title: string; id?: string }): Promise<string>;
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
    async open({ person, engine, title, id = randomUUID() }) {
      const { rows } = await (
        await db()
      ).query(
        `INSERT INTO ${CHATS} (id, person, engine, title) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, person, engine, title],
      );
      if (!rows.length) throw new SanomaError("invalid_input", `Chat ${id} exists already; open it with another id`);
      return id;
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
