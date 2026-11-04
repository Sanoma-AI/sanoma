import type { UIMessage } from "ai";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import { chatMessages, chats } from "./db/company.ts";
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
}

const chatOf = ({ draftId, createdAt, ...row }: typeof chats.$inferSelect): Chat => ({
  ...row,
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
      return rows.map((row) => row.message as UIMessage);
    },
    async get(id) {
      const [row] = await (await db()).select().from(chats).where(eq(chats.id, id));
      return row && chatOf(row);
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
