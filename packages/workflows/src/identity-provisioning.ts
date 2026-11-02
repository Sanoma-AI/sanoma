import type { Pool, PoolClient } from "pg";
import type { IdentityEnrollment } from "./cloud-identity.ts";

export type DeploymentIdentity = Omit<IdentityEnrollment, "generation">;
export interface EnrollIdentity extends IdentityEnrollment {
  hash: string;
  validUntil: string;
}

/** Provisioning authority only. The serving broker receives the separate read-only interface. */
export interface IdentityProvisioning {
  enroll(input: EnrollIdentity): Promise<void>;
  retire(input: DeploymentIdentity & { generation: number; validUntil: string }): Promise<void>;
  revoke(input: DeploymentIdentity): Promise<void>;
}

export class IdentityProvisioningError extends Error {
  readonly retryable: boolean;
  readonly code: "invalid" | "conflict" | "unavailable";
  constructor(code: "invalid" | "conflict" | "unavailable") {
    super(`Identity provisioning: ${code}`);
    this.name = "IdentityProvisioningError";
    this.code = code;
    this.retryable = code === "unavailable";
  }
}

/** Recognize another package copy without ever forwarding arbitrary messages or code strings. */
export function identityProvisioningCode(error: unknown): IdentityProvisioningError["code"] | undefined {
  if (!error || typeof error !== "object" || !("name" in error) || error.name !== "IdentityProvisioningError") return;
  if (!("code" in error)) return;
  switch (error.code) {
    case "invalid":
      return "invalid";
    case "conflict":
      return "conflict";
    case "unavailable":
      return "unavailable";
  }
}

function fail(code: "invalid" | "conflict"): never {
  throw new IdentityProvisioningError(code);
}
const sameIdentity = (a: DeploymentIdentity, b: DeploymentIdentity) =>
  a.deployment === b.deployment &&
  a.company === b.company &&
  a.environment === b.environment &&
  a.serviceAccount === b.serviceAccount;
const checkIdentity = (input: DeploymentIdentity) => {
  if (
    ![input.deployment, input.company, input.environment].every(
      (s) => typeof s === "string" && s.length > 0 && s.length <= 256 && !s.includes("\0"),
    ) ||
    !/^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(input.serviceAccount)
  )
    fail("invalid");
};
const generationOf = (generation: number) => {
  if (!Number.isSafeInteger(generation) || generation <= 0) fail("invalid");
};
const deadlineOf = (value: string) => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail("invalid");
  return time;
};

/** Caller owns a dedicated writer pool; never give this pool to the broker or company code. */
export function postgresIdentityProvisioning(
  database: () => Promise<Pick<Pool, "connect">>,
  options: { maxValidityMs: number },
): IdentityProvisioning {
  const maximum = options.maxValidityMs;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) fail("invalid");
  async function transaction(
    input: DeploymentIdentity,
    create: boolean,
    run: (db: PoolClient, enabled: boolean, now: number) => Promise<void>,
  ) {
    checkIdentity(input);
    let db: PoolClient | undefined;
    try {
      db = await (await database()).connect();
      await db.query("BEGIN");
      if (create)
        await db.query(
          `INSERT INTO sanoma_identity.deployments (id, company, environment, service_account)
          VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
          [input.deployment, input.company, input.environment, input.serviceAccount],
        );
      // Every writer takes the deployment row lock: enrollment cannot race revocation/retirement.
      const { rows } = await db.query<DeploymentIdentity & { enabled: boolean }>(
        `SELECT id AS deployment, company, environment, service_account AS "serviceAccount", enabled
          FROM sanoma_identity.deployments WHERE id=$1 FOR UPDATE`,
        [input.deployment],
      );
      const row = rows[0];
      if (!row || !sameIdentity(row, input)) fail("conflict");
      const clock = await db.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      await run(db, row.enabled, clock.rows[0]!.now.getTime());
      await db.query("COMMIT");
    } catch (error) {
      await db?.query("ROLLBACK").catch(() => {});
      const code = identityProvisioningCode(error);
      if (code) throw new IdentityProvisioningError(code);
      if ((error as { code?: string })?.code === "23505") throw new IdentityProvisioningError("conflict");
      throw new IdentityProvisioningError("unavailable");
    } finally {
      db?.release();
    }
  }
  return {
    async enroll(input) {
      generationOf(input.generation);
      const until = deadlineOf(input.validUntil);
      if (!/^[0-9a-f]{64}$/.test(input.hash)) fail("invalid");
      await transaction(input, true, async (db, enabled, now) => {
        if (!enabled) fail("conflict");
        if (until <= now || until - now > maximum) fail("invalid");
        const { rows } = await db.query<{ generation: string; hash: string; valid_until: Date; revoked: boolean }>(
          `SELECT generation, hash, valid_until, revoked FROM sanoma_identity.credentials
            WHERE deployment=$1 ORDER BY generation DESC`,
          [input.deployment],
        );
        const existing = rows.find((r) => Number(r.generation) === input.generation);
        if (existing) {
          // An exact retry is safe. Never extend a retired generation or revive a revoked one.
          if (existing.hash !== input.hash || existing.revoked || existing.valid_until.getTime() !== until)
            fail("conflict");
          return;
        }
        if (rows[0] && Number(rows[0].generation) >= input.generation) fail("conflict");
        await db.query(
          `INSERT INTO sanoma_identity.credentials (hash, deployment, generation, valid_until)
            VALUES ($1,$2,$3,$4)`,
          [input.hash, input.deployment, input.generation, new Date(until)],
        );
      });
    },
    async retire(input) {
      generationOf(input.generation);
      const until = deadlineOf(input.validUntil);
      await transaction(input, false, async (db) => {
        // Retirement only shortens access. The predicate protects the schema's finite interval.
        const result = await db.query(
          `UPDATE sanoma_identity.credentials SET
            revoked=revoked OR $3::timestamptz <= clock_timestamp(),
            valid_until=CASE WHEN $3::timestamptz > valid_from THEN LEAST(valid_until,$3::timestamptz) ELSE valid_until END
            WHERE deployment=$1 AND generation=$2`,
          [input.deployment, input.generation, new Date(until)],
        );
        if (!result.rowCount) fail("conflict");
      });
    },
    async revoke(input) {
      await transaction(input, false, async (db) => {
        // Terminal for this deployment id. A new enrollment cannot silently re-enable it.
        await db.query("UPDATE sanoma_identity.deployments SET enabled=false WHERE id=$1", [input.deployment]);
      });
    },
  };
}

/** Run-local sandbox authority: never reads or mutates the live enrollment database. */
export function memoryIdentityProvisioning(): IdentityProvisioning {
  const deployments = new Map<
    string,
    { identity: DeploymentIdentity; enabled: boolean; credentials: Map<number, EnrollIdentity> }
  >();
  const hashes = new Set<string>();
  const find = (input: DeploymentIdentity) => {
    checkIdentity(input);
    const found = deployments.get(input.deployment);
    if (!found || !sameIdentity(found.identity, input)) return fail("conflict");
    return found;
  };
  return {
    async enroll(input) {
      checkIdentity(input);
      generationOf(input.generation);
      if (deadlineOf(input.validUntil) <= Date.now() || !/^[0-9a-f]{64}$/.test(input.hash)) fail("invalid");
      const found = deployments.get(input.deployment);
      if (found && (!sameIdentity(found.identity, input) || !found.enabled)) fail("conflict");
      const current = found?.credentials.get(input.generation);
      if (current) {
        if (current.hash !== input.hash || deadlineOf(current.validUntil) !== deadlineOf(input.validUntil))
          fail("conflict");
        return;
      }
      if (hashes.has(input.hash) || (found && [...found.credentials.keys()].some((g) => g >= input.generation)))
        fail("conflict");
      const row = found ?? { identity: { ...input }, enabled: true, credentials: new Map<number, EnrollIdentity>() };
      row.credentials.set(input.generation, { ...input });
      hashes.add(input.hash);
      deployments.set(input.deployment, row);
    },
    async retire(input) {
      generationOf(input.generation);
      const deadline = deadlineOf(input.validUntil);
      const current = find(input).credentials.get(input.generation);
      if (!current) return fail("conflict");
      current.validUntil = new Date(Math.min(deadlineOf(current.validUntil), deadline)).toISOString();
    },
    async revoke(input) {
      find(input).enabled = false;
    },
  };
}
