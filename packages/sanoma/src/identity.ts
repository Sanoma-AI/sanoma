import { startIdentityService, type IdentityServiceOptions } from "sanoma/workflows/identity-service";

/** Deployment-only: no company config, .env loading, local database creation or fallback identity. */
export function runIdentity(env: NodeJS.ProcessEnv = process.env) {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Identity service requires ${name}`);
    return value;
  };
  const type = required("SANOMA_IDENTITY_MODE");
  if (type !== "runtime" && type !== "provisioning") throw new Error("Invalid SANOMA_IDENTITY_MODE");
  const mode: IdentityServiceOptions["mode"] =
    type === "runtime"
      ? { type }
      : {
          type,
          identity: {
            serviceAccount: required("SANOMA_IDENTITY_SOURCE_ACCOUNT"),
            subject: required("SANOMA_IDENTITY_SOURCE_SUBJECT"),
            audience: required("SANOMA_IDENTITY_AUDIENCE"),
          },
        };
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid identity service PORT");
  return startIdentityService({
    enrollmentDatabaseUrl: required("SANOMA_IDENTITY_READ_DATABASE_URL"),
    auditDatabaseUrl: required("SANOMA_IDENTITY_AUDIT_DATABASE_URL"),
    mode,
    host: env.SANOMA_IDENTITY_HOST ?? "0.0.0.0",
    port,
    maxConcurrentRequests: Number(env.SANOMA_IDENTITY_CONCURRENCY ?? "32"),
  });
}
