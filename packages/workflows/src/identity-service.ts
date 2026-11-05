import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { NodeRequest, sendNodeResponse } from "srvx/node";
import { type Db, databaseOn } from "./db.ts";
import { identityAuditEvents } from "./db/identity.ts";
import {
  identityBroker,
  postgresIdentityEnrollments,
  attachedGoogleTokenIssuer,
  provisioningIdentityBroker,
  attachedGoogleIdTokenIssuer,
  type ProvisioningIdentity,
  type IdentityAudit,
} from "./cloud-identity.ts";

/** Install with administrative authority in the audit database, separately from the serving process. */
export const CLOUD_IDENTITY_AUDIT_SQL = `
CREATE SCHEMA IF NOT EXISTS sanoma_identity;
REVOKE ALL ON SCHEMA sanoma_identity FROM PUBLIC;
CREATE TABLE IF NOT EXISTS sanoma_identity.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  result text NOT NULL CHECK (result IN ('issued', 'denied', 'unavailable')),
  deployment text, company text, environment text, service_account text,
  generation bigint, expires_at timestamptz
);
REVOKE ALL ON sanoma_identity.audit_events FROM PUBLIC;
`;

export interface IdentityServiceOptions {
  /** Explicit broker database login with SELECT only on the enrollment tables. */
  enrollmentDatabaseUrl: string;
  /** Explicit audit database login with INSERT only on audit_events. */
  auditDatabaseUrl: string;
  mode: { type: "runtime" } | { type: "provisioning"; identity: ProvisioningIdentity };
  /** Cloud Run terminates TLS. Keep this service behind the deployment's HTTPS ingress. */
  host?: string;
  port?: number;
  /** Bound in-flight issuance work and database waiters; excess requests receive 429. */
  maxConcurrentRequests?: number;
}

const unavailable = () => new Error("Identity service unavailable");
const poolFor = (connectionString: string) => {
  if (!connectionString) throw unavailable();
  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  });
  // Never forward database diagnostics: they can contain connection information.
  pool.on("error", () => {});
  return pool;
};

async function checkRoles(reader: Db, audit: Db): Promise<void> {
  const read = await reader.execute<{ allowed: boolean }>(sql`SELECT
    has_schema_privilege('sanoma_identity', 'USAGE') AND
    NOT has_schema_privilege('sanoma_identity', 'CREATE') AND
    NOT EXISTS (SELECT FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)) AND
    has_table_privilege('sanoma_identity.deployments', 'SELECT') AND
    has_table_privilege('sanoma_identity.credentials', 'SELECT') AND
    NOT has_table_privilege('sanoma_identity.deployments', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AND
    NOT has_table_privilege('sanoma_identity.credentials', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed`);
  const write = await audit.execute<{ allowed: boolean }>(sql`SELECT
    has_schema_privilege('sanoma_identity', 'USAGE') AND
    NOT has_schema_privilege('sanoma_identity', 'CREATE') AND
    NOT EXISTS (SELECT FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)) AND
    has_table_privilege('sanoma_identity.audit_events', 'INSERT') AND
    NOT has_table_privilege('sanoma_identity.audit_events', 'SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed`);
  if (read.rows[0]?.allowed !== true || write.rows[0]?.allowed !== true) throw unavailable();
}

/** Starts a standalone broker without loading company code, starting a worker or installing schemas. */
export async function startIdentityService(options: IdentityServiceOptions): Promise<{
  url: string;
  stop(): Promise<void>;
}> {
  let reader: Pool | undefined, audit: Pool | undefined;
  const server = createServer();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await Promise.all([reader?.end(), audit?.end()]);
    })());
  try {
    const limit = options.maxConcurrentRequests ?? 32;
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw unavailable();
    let active = 0;
    reader = poolFor(options.enrollmentDatabaseUrl);
    audit = poolFor(options.auditDatabaseUrl);
    const readerDb = databaseOn(reader);
    const auditDb = databaseOn(audit);
    await checkRoles(readerDb, auditDb);
    const record = async (event: IdentityAudit) => {
      const e = event.enrollment;
      // Fixed columns only: no tokens, hashes, headers or arbitrary caller fields.
      await auditDb.insert(identityAuditEvents).values({
        result: event.result,
        deployment: e?.deployment,
        company: e?.company,
        environment: e?.environment,
        serviceAccount: e?.serviceAccount,
        generation: e?.generation,
        expiresAt: event.expiresAt === undefined ? null : new Date(event.expiresAt),
      });
    };
    const enrollments = postgresIdentityEnrollments(async () => readerDb);
    const handle =
      options.mode.type === "runtime"
        ? identityBroker({ enrollments, issue: attachedGoogleTokenIssuer(), audit: record })
        : options.mode.type === "provisioning"
          ? provisioningIdentityBroker({
              identity: options.mode.identity,
              enrollments,
              issue: attachedGoogleIdTokenIssuer(options.mode.identity),
              audit: record,
            })
          : (() => {
              throw unavailable();
            })();
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.on("request", (req, res) => {
      // Fetch Request adapters may hide a GET body. Refuse it at the HTTP boundary.
      if (
        req.method === "GET" &&
        (req.headers["transfer-encoding"] || (req.headers["content-length"] ?? "0") !== "0")
      ) {
        res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end('{"error":"invalid_request"}');
        return;
      }
      if (req.url === "/health" && (req.method === "GET" || req.method === "HEAD")) {
        res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        res.end("ok\n");
        return;
      }
      if (active >= limit) {
        res.writeHead(429, { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "1" });
        res.end('{"error":"busy"}');
        return;
      }
      active++;
      Promise.resolve()
        .then(() => handle(new NodeRequest({ req, res })))
        .then((response) => sendNodeResponse(res, response))
        .catch(() => {
          if (res.headersSent) res.destroy();
          else {
            res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end('{"error":"unavailable"}');
          }
        })
        .finally(() => {
          active--;
        });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 8080, options.host ?? "127.0.0.1", resolve);
    });
    const { address, family, port } = server.address() as AddressInfo;
    const hostname =
      address === "0.0.0.0" || address === "::" ? "localhost" : family === "IPv6" ? `[${address}]` : address;
    return { url: `http://${hostname}:${port}`, stop: close };
  } catch {
    await close().catch(() => {});
    throw unavailable();
  }
}
