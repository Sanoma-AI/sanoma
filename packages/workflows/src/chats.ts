import type { UIMessage, UIMessageChunk } from "ai";
import { and, asc, desc, eq, gt, ne, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import { chatChunks, chatMessages, chats } from "./db/company.ts";
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

const chatOf = ({ id, person, engine, title, draftId, createdAt }: typeof chats.$inferSelect): Chat => ({
  id,
  person,
  engine,
  title,
  ...(draftId === null ? {} : { draftId }),
  createdAt: createdAt.getTime(),
});

/** The chats' store on the database `db` gives, the config's database once it is prepared. */
export function chatStore(db: () => Promise<Db>): Chats {
  return {
    async open({ id, person, engine, title }) {
      const opened = await (
        await db()
      )
        .insert(chats)
        .values({ id, person, engine, title })
        .onConflictDoNothing()
        .returning({ id: chats.id });
      if (!opened.length) throw new SanomaError("invalid_input", `Chat ${id} exists already; open it with another id`);
    },
    async attach(id, draftId) {
      await (await db()).update(chats).set({ draftId }).where(eq(chats.id, id));
    },
    async upsert(id, messages) {
      if (!messages.length) return;
      if (messages.some((m) => !m.id)) throw new SanomaError("invalid_input", "A chat message needs an id");
      // A new message's place is after the chat's last, in the order given.
      const last = sql`(SELECT coalesce(max(${chatMessages.seq}), 0) FROM ${chatMessages} WHERE ${eq(chatMessages.chatId, id)})`;
      await (
        await db()
      )
        .insert(chatMessages)
        .values(
          messages.map((message, n) => ({ chatId: id, id: message.id, seq: sql<number>`${last} + ${n + 1}`, message })),
        )
        .onConflictDoUpdate({
          target: [chatMessages.chatId, chatMessages.id],
          set: { message: sql`excluded.message` },
        });
    },
    async load(id) {
      const rows = await (
        await db()
      )
        .select({ message: chatMessages.message })
        .from(chatMessages)
        .where(eq(chatMessages.chatId, id))
        .orderBy(asc(chatMessages.seq), asc(chatMessages.id));
      return rows.map((row) => row.message);
    },
    async get(id) {
      const [row] = await (await db()).select().from(chats).where(eq(chats.id, id));
      return row && chatOf(row);
    },
    async begin(id, turn) {
      const database = await db();
      const begun = await database
        .update(chats)
        .set({ turn })
        .where(and(eq(chats.id, id), sql`${chats.turn} IS DISTINCT FROM ${turn}`))
        .returning({ id: chats.id });
      await database.delete(chatChunks).where(and(eq(chatChunks.chatId, id), ne(chatChunks.runId, turn)));
      return begun.length > 0;
    },
    async append(id, turn, chunks) {
      if (chunks.length) await appendChunks(await db(), id, turn, chunks);
    },
    async end(id, turn) {
      await appendChunks(await db(), id, turn, [null]);
    },
    async chunks(turn, after) {
      const rows = await (
        await db()
      )
        .select({ seq: chatChunks.seq, chunk: chatChunks.chunk })
        .from(chatChunks)
        .where(and(eq(chatChunks.runId, turn), gt(chatChunks.seq, after)))
        .orderBy(asc(chatChunks.seq));
      return {
        chunks: rows.flatMap((row) => (row.chunk === null ? [] : [row.chunk])),
        last: rows.at(-1)?.seq ?? after,
        ended: rows.at(-1)?.chunk === null,
      };
    },
    async list(person) {
      const rows = await (
        await db()
      )
        .select()
        .from(chats)
        .where(eq(chats.person, person))
        .orderBy(desc(chats.createdAt), asc(chats.id))
        .limit(50);
      return rows.map(chatOf);
    },
  };
}

/** Writes `chunks` (null, the end) after the turn's last, in the order given. */
async function appendChunks(db: Db, id: string, turn: string, chunks: readonly (UIMessageChunk | null)[]) {
  // A chunk's place is after the turn's last, in the order given.
  const last = sql`(SELECT coalesce(max(${chatChunks.seq}), 0) FROM ${chatChunks} WHERE ${eq(chatChunks.runId, turn)})`;
  await db
    .insert(chatChunks)
    .values(chunks.map((chunk, n) => ({ chatId: id, runId: turn, seq: sql<number>`${last} + ${n + 1}`, chunk })));
}
