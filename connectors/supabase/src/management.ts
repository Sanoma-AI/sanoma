import { type CallContext, type Driver, DriverError, type DriverFn, storeDatabaseUrl } from "sanoma/workflows";
import { PASSWORD_SECRET } from "./connector.ts";

// The operations the provider's project does not carry, over Supabase's Management API
// (https://api.supabase.com/api/v1): the driver's `ManagementApi` calls it, the fake's answers
// from its state. Both go through `withManagement`, which shapes the answers the same way.

/** A project as `GET /v1/projects` lists it: the fields read here. */
export interface ApiProject {
  id: string;
  ref?: string;
  name: string;
  organization_id: string;
  organization_slug?: string;
  status?: string;
}

/** One of a project's poolers, as `GET /v1/projects/{ref}/config/database/pooler` lists them. */
export interface ApiPooler {
  database_type: string;
  db_host: string;
  db_user: string;
  db_name: string;
}

/** An organization, as `GET /v1/organizations` lists it: the fields read here. */
export interface ApiOrganization {
  id: string;
  name: string;
}

/** One service's health, as `GET /v1/projects/{ref}/health` lists them. */
export interface ApiHealth {
  name: string;
  healthy: boolean;
  status: string;
}

/** Supabase's Management API, its answers as it sends them. Each call fails with a `DriverError`. */
export interface ManagementApi {
  organizations(): Promise<ApiOrganization[]>;
  projects(): Promise<ApiProject[]>;
  pooler(ref: string): Promise<ApiPooler[]>;
  health(ref: string, services: readonly string[]): Promise<ApiHealth[]>;
}

/** The services `project.health` reads when none are named: what a worker needs. */
const HEALTH_SERVICES = ["db", "pooler"] as const;

/** A project's statuses while it is deleted, and after: not a twin of a new one. */
const GONE = new Set(["GOING_DOWN", "REMOVED"]);

/** The session pooler's port: the transaction pooler's (6543) does not carry LISTEN/NOTIFY, which DBOS needs. */
const SESSION_PORT = 5432;

/**
 * `driver` (the provider's) with the Management API's operations over `api(call)`, made on each
 * call with that call's credentials: `organization.list`, `pooler.get`, `project.health`,
 * `database.storeUrl`, and `project.create` refusing a name the organization has a project of already.
 */
export function withManagement(driver: Driver, api: (call: CallContext) => ManagementApi): Driver {
  const create = driver.ops["project.create"]!;
  const pooler = async (ref: string, call: CallContext) => {
    const primary = (await api(call).pooler(ref)).find((p) => p.database_type === "PRIMARY");
    if (!primary) throw new DriverError(`supabase: ${ref} has no primary database pooler`, { retryable: false });
    return { host: primary.db_host, port: SESSION_PORT, user: primary.db_user, database: primary.db_name };
  };
  const ops: Record<string, DriverFn> = {
    ...driver.ops,
    // Not idempotent: a create retried after Supabase made the project, but before the run saw
    // it, finds it here and stops, rather than making a second one.
    "project.create": async (input: { desired: { name: string; organization_id: string } }, call: CallContext) => {
      const { name, organization_id: org } = input.desired;
      const twin = (await api(call).projects()).find(
        (p) =>
          p.name === name && (p.organization_id === org || p.organization_slug === org) && !GONE.has(p.status ?? ""),
      );
      if (twin) {
        throw new DriverError(
          `supabase: project.create: the organization ${org} has a project named ${name} already (${twin.ref ?? twin.id}); bind it instead`,
          { retryable: false, vendorCode: "exists" },
        );
      }
      return create(input, call);
    },
    "organization.list": async (_input: unknown, call: CallContext) => ({
      organizations: (await api(call).organizations()).map(({ id, name }) => ({ id, name })),
    }),
    "project.health": async (
      { ref, services = HEALTH_SERVICES }: { ref: string; services?: readonly string[] },
      call: CallContext,
    ) => {
      const answers = (await api(call).health(ref, services)).map(({ name, healthy, status }) => ({
        name,
        healthy,
        status,
      }));
      return { healthy: answers.length > 0 && answers.every((s) => s.healthy), services: answers };
    },
    "pooler.get": ({ ref }: { ref: string }, call: CallContext) => pooler(ref, call),
    "database.storeUrl": async ({ ref, export: name }: { ref: string; export: string }, call: CallContext) => {
      const { secrets } = call;
      const password = await secrets.get(PASSWORD_SECRET);
      if (password === undefined) {
        throw new DriverError(`supabase: database.storeUrl: the secret ${PASSWORD_SECRET} is not set`, {
          retryable: false,
        });
      }
      const { host, port, user, database } = await pooler(ref, call);
      const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}?sslmode=require`;
      return storeDatabaseUrl(secrets, name, url, {
        where: "supabase: database.storeUrl",
        others: "another project, pooler or password",
      });
    },
  };
  return Object.freeze({ ...driver, ops: Object.freeze(ops) });
}

/** A `DriverError` for the Management API's answer `status` to `GET path`, retryable as the runtime's rule says. */
export function apiError(path: string, status: number, message: string, retryable: boolean): DriverError {
  return new DriverError(`supabase: GET ${path} answered ${status}: ${message}`, { retryable, status });
}
