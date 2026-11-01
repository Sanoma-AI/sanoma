import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { API_TOKENS_TABLE as TABLE } from "./db.ts";
import type { Principal } from "./define.ts";
import { generateSecret, tokenHash as hashOf } from "./secret.ts";

// The api tokens, in the config's database beside the runtime's other tables: a caller of a
// public site's api (`callFn`) with `Authorization: Bearer sca_…` is the principal `token:<id>`,
// a visitor, with the row's groups. Only a token's SHA-256 is kept; the token is shown once, at mint.

/** What every token starts with, so a bearer that is not one is told at a glance. */
const PREFIX = "sca_";

/** The api tokens' store, `SanomaClient.tokens`. */
export interface Tokens {
  /**
   * Mints a token acting for `subject` (the principal it stands for, such as the account's
   * `visitor:better-auth:<id>`) in `groups`: its id (`id`, or a new one) and the token, which is
   * shown only here. An id another token has is refused.
   */
  mint(token: { id?: string; subject: string; groups: readonly string[] }): Promise<{ id: string; token: string }>;
  /** Revokes the token `id`: it resolves to nobody from now on. Revoking one revoked or missing does nothing. */
  revoke(token: { id: string }): Promise<void>;
  /**
   * Who a bearer token is (`token:<id>`, in its row's groups), with the subject it acts for;
   * undefined for anything not a token minted here, or one revoked.
   */
  resolve(token: string): Promise<{ principal: Principal; subject: string } | undefined>;
  /** The subject the token `id` acts for (a workflow's `ctx.startedBy.subject`); undefined for one revoked or missing. */
  subjectOf(id: string): Promise<string | undefined>;
}

export function tokenStore(db: () => Promise<Pool>): Tokens {
  return {
    async mint({ id = randomUUID(), subject, groups }) {
      const token = `${PREFIX}${generateSecret()}`;
      await (
        await db()
      ).query(`INSERT INTO ${TABLE} (id, hash, subject, groups) VALUES ($1, $2, $3, $4::jsonb)`, [
        id,
        hashOf(token),
        subject,
        JSON.stringify(groups),
      ]);
      return { id, token };
    },
    async revoke({ id }) {
      await (await db()).query(`UPDATE ${TABLE} SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [id]);
    },
    async resolve(token) {
      if (!token.startsWith(PREFIX)) return undefined;
      // Looked up by its hash: the token itself is never stored, so there is nothing to compare it to.
      const { rows } = await (
        await db()
      ).query<{ id: string; subject: string; groups: string[] }>(
        `SELECT id, subject, groups FROM ${TABLE} WHERE hash = $1 AND revoked_at IS NULL`,
        [hashOf(token)],
      );
      const row = rows[0];
      if (!row) return undefined;
      return { principal: { id: `token:${row.id}`, groups: row.groups }, subject: row.subject };
    },
    async subjectOf(id) {
      const { rows } = await (
        await db()
      ).query<{ subject: string }>(`SELECT subject FROM ${TABLE} WHERE id = $1 AND revoked_at IS NULL`, [id]);
      return rows[0]?.subject;
    },
  };
}

/** The api tokens in memory, for a sandbox run's `sanoma.token.*`: the same contract, nothing kept past the process. */
export function memoryTokens(): Tokens {
  const rows = new Map<string, { hash: string; subject: string; groups: string[]; revoked: boolean }>();
  return {
    async mint({ id = randomUUID(), subject, groups }) {
      if (rows.has(id)) throw new Error(`A token with the id ${id} exists`);
      const token = `${PREFIX}${generateSecret()}`;
      rows.set(id, { hash: hashOf(token), subject, groups: [...groups], revoked: false });
      return { id, token };
    },
    async revoke({ id }) {
      const row = rows.get(id);
      if (row) row.revoked = true;
    },
    async resolve(token) {
      const hash = hashOf(token);
      for (const [id, row] of rows) {
        if (row.hash === hash && !row.revoked) {
          return { principal: { id: `token:${id}`, groups: [...row.groups] }, subject: row.subject };
        }
      }
      return undefined;
    },
    async subjectOf(id) {
      const row = rows.get(id);
      return row && !row.revoked ? row.subject : undefined;
    },
  };
}
