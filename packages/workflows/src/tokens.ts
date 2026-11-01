import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { API_TOKENS_TABLE as TABLE } from "./db.ts";
import type { Principal } from "./define.ts";

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
}

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

export function tokenStore(db: () => Promise<Pool>): Tokens {
  return {
    async mint({ id = randomUUID(), subject, groups }) {
      const token = `${PREFIX}${randomBytes(32).toString("base64url")}`;
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
  };
}
