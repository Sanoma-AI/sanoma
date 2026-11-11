import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lt, type SQL, sql } from "drizzle-orm";
import { calculatePKCECodeChallenge } from "oauth4webapi";
import { pgCode, type Db } from "./db.ts";
import { apiTokens, tokenHandoffs } from "./db/company.ts";
import type { Principal } from "./define.ts";
import { generateSecret } from "./secret.ts";

// The api tokens, in the config's database beside the runtime's other tables: a caller of a
// public site's api (`callFn`) with `Authorization: Bearer sca_…` is the principal `token:<id>`,
// a visitor, with the row's groups. Only a token's SHA-256 is kept; the token is shown once, at mint.
// A token stored as a secret is handed to another machine by a one-time code (`handoff`, then
// `redeem`), as a native app's sign-in is (RFC 8252, with PKCE): only the code goes through a
// browser, and its table keeps only its SHA-256.

/**
 * A bearer token's sha256, hex: all a table keeps of one (the wakeup service's, the api tokens). A
 * token is found by its hash (a unique index), so the secret itself is never compared.
 */
export const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

/** What every token starts with, so a bearer that is not one is told at a glance. */
const PREFIX = "sca_";

/** Register only a generated bearer retained by trusted provisioning, never a workflow value. */
export interface TokenRegistration {
  id: string;
  token: string;
  subject: string;
  groups: readonly string[];
}

export const newApiToken = () => `${PREFIX}${generateSecret()}`;

const groupsOf = (groups: readonly string[]) => [...new Set(groups)].toSorted();
const registrationOf = (input: TokenRegistration) => {
  if (!input.id || !input.subject || !/^sca_[A-Za-z0-9_-]{43}$/.test(input.token))
    throw new Error("Invalid token registration");
  return { ...input, hash: tokenHash(input.token), groups: groupsOf(input.groups) };
};

/** What a handoff's code starts with. */
const CODE_PREFIX = "sch_";
/** The longest a handoff's code is good for: five minutes. */
export const HANDOFF_MS = 300_000;

/** A handoff's lifetime, refused unless it is a whole number of milliseconds up to `HANDOFF_MS`. */
function handoffTtl(ttlMs: number): number {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > HANDOFF_MS)
    throw new Error(`A handoff lasts 1 to ${HANDOFF_MS} ms`);
  return ttlMs;
}

/** The api tokens' store, `SanomaClient.tokens`. */
export interface Tokens {
  /**
   * Mints a token acting for `subject` (the principal it stands for, such as the account's
   * `visitor:better-auth:<id>`) in `groups`: its id (`id`, or a new one) and the token, which is
   * shown only here. An id another token has is refused.
   */
  mint(token: { id?: string; subject: string; groups: readonly string[] }): Promise<{ id: string; token: string }>;
  /** Register a saved bearer, or confirm the identical active registration. Conflicts and revocation return false. */
  register(token: TokenRegistration): Promise<boolean>;
  /** Revokes the token `id`: it resolves to nobody from now on. Revoking one revoked or missing does nothing. */
  revoke(token: { id: string }): Promise<void>;
  /**
   * Who a bearer token is (`token:<id>`, in its row's groups), with the subject it acts for;
   * undefined for anything not a token minted here, or one revoked.
   */
  resolve(token: string): Promise<{ principal: Principal; subject: string } | undefined>;
  /** The subject the token `id` acts for (a workflow's `ctx.startedBy.subject`); undefined for one revoked or missing. */
  subjectOf(id: string): Promise<string | undefined>;
  /**
   * A one-time code, `sch_…`, for the token stored under the secret `store`: good for `ttlMs` (at
   * most `HANDOFF_MS`), once, and only with the verifier `challenge` was made from (PKCE S256).
   * Its table keeps only the code's hash; the database's store sweeps those expired at each handoff.
   */
  handoff(input: { store: string; challenge: string; ttlMs: number }): Promise<{ code: string }>;
  /**
   * The secret a code hands off, once: undefined for a code unknown, expired or redeemed, and for
   * a verifier that is not its challenge's, which leaves the code as it was. Of two at once, one
   * has it.
   */
  redeem(input: { code: string; verifier: string }): Promise<{ store: string } | undefined>;
}

const active = (where: SQL | undefined) => and(where, isNull(apiTokens.revokedAt));

export function tokenStore(db: () => Promise<Db>): Tokens {
  return {
    async mint({ id = randomUUID(), subject, groups }) {
      const token = newApiToken();
      await (await db()).insert(apiTokens).values({ id, hash: tokenHash(token), subject, groups: [...groups] });
      return { id, token };
    },
    async register(input) {
      const { id, hash, subject, groups } = registrationOf(input);
      try {
        // A duplicate id changes nothing unless it is this same active registration (the no-op
        // update makes the row come back).
        const registered = await (
          await db()
        )
          .insert(apiTokens)
          .values({ id, hash, subject, groups })
          .onConflictDoUpdate({
            target: apiTokens.id,
            set: { id },
            setWhere: and(
              eq(apiTokens.hash, hash),
              eq(apiTokens.subject, subject),
              sql`${apiTokens.groups} @> ${sql.param(groups, apiTokens.groups)} AND ${apiTokens.groups} <@ ${sql.param(groups, apiTokens.groups)}`,
              isNull(apiTokens.revokedAt),
            ),
          })
          .returning({ id: apiTokens.id });
        return registered.length === 1;
      } catch (error) {
        // A bearer already registered under another ID cannot acquire a second identity.
        if (pgCode(error) === "23505") return false;
        throw error;
      }
    },
    async revoke({ id }) {
      await (
        await db()
      )
        .update(apiTokens)
        .set({ revokedAt: sql`now()` })
        .where(active(eq(apiTokens.id, id)));
    },
    async resolve(token) {
      if (!token.startsWith(PREFIX)) return undefined;
      // Looked up by its hash: the token itself is never stored, so there is nothing to compare it to.
      const [row] = await (
        await db()
      )
        .select({ id: apiTokens.id, subject: apiTokens.subject, groups: apiTokens.groups })
        .from(apiTokens)
        .where(active(eq(apiTokens.hash, tokenHash(token))));
      if (!row) return undefined;
      return { principal: { id: `token:${row.id}`, groups: row.groups }, subject: row.subject };
    },
    async subjectOf(id) {
      const [row] = await (
        await db()
      )
        .select({ subject: apiTokens.subject })
        .from(apiTokens)
        .where(active(eq(apiTokens.id, id)));
      return row?.subject;
    },
    async handoff({ store, challenge, ttlMs }) {
      const ttl = handoffTtl(ttlMs);
      const code = `${CODE_PREFIX}${generateSecret()}`;
      const conn = await db();
      // The database's clock, which the app's redeem compares with too.
      await conn.delete(tokenHandoffs).where(lt(tokenHandoffs.expiresAt, sql`now()`));
      await conn.insert(tokenHandoffs).values({
        codeHash: tokenHash(code),
        store,
        challenge,
        expiresAt: sql`now() + ${ttl}::integer * interval '1 millisecond'`,
      });
      return { code };
    },
    async redeem({ code, verifier }) {
      // One statement, so of two redeems one has it. The verifier is matched by its S256 hash
      // against the challenge, which is public (it went through the browser): an equality there
      // tells nothing of the verifier, so it needs no constant-time compare.
      const [row] = await (
        await db()
      )
        .update(tokenHandoffs)
        .set({ redeemedAt: sql`now()` })
        .where(
          and(
            eq(tokenHandoffs.codeHash, tokenHash(code)),
            eq(tokenHandoffs.challenge, await calculatePKCECodeChallenge(verifier)),
            isNull(tokenHandoffs.redeemedAt),
            gt(tokenHandoffs.expiresAt, sql`now()`),
          ),
        )
        .returning({ store: tokenHandoffs.store });
      return row;
    },
  };
}

/** The api tokens in memory, for a sandbox run's `sanoma.token.*`: the same contract, nothing kept past the process. */
export function memoryTokens(): Tokens {
  const rows = new Map<string, { hash: string; subject: string; groups: string[]; revoked: boolean }>();
  const handoffs = new Map<string, { store: string; challenge: string; expiresAt: number; redeemed: boolean }>();
  return {
    async mint({ id = randomUUID(), subject, groups }) {
      if (rows.has(id)) throw new Error(`A token with the id ${id} exists`);
      const token = newApiToken();
      rows.set(id, { hash: tokenHash(token), subject, groups: [...groups], revoked: false });
      return { id, token };
    },
    async register(input) {
      const { id, hash, subject, groups } = registrationOf(input);
      const row = rows.get(id);
      if (row)
        return (
          !row.revoked &&
          row.hash === hash &&
          row.subject === subject &&
          JSON.stringify(groupsOf(row.groups)) === JSON.stringify(groups)
        );
      if ([...rows.values()].some((other) => other.hash === hash)) return false;
      rows.set(id, { hash, subject, groups, revoked: false });
      return true;
    },
    async revoke({ id }) {
      const row = rows.get(id);
      if (row) row.revoked = true;
    },
    async resolve(token) {
      const hash = tokenHash(token);
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
    async handoff({ store, challenge, ttlMs }) {
      const ttl = handoffTtl(ttlMs);
      const code = `${CODE_PREFIX}${generateSecret()}`;
      handoffs.set(tokenHash(code), { store, challenge, expiresAt: Date.now() + ttl, redeemed: false });
      return { code };
    },
    async redeem({ code, verifier }) {
      const handoff = handoffs.get(tokenHash(code));
      const challenge = await calculatePKCECodeChallenge(verifier);
      // Checked and marked with no wait between: of two redeems one has it.
      if (!handoff || handoff.redeemed || handoff.expiresAt <= Date.now() || handoff.challenge !== challenge)
        return undefined;
      handoff.redeemed = true;
      return { store: handoff.store };
    },
  };
}
