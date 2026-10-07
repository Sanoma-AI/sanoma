import type { WorkflowDefinition } from "./define.ts";
import type { LedgerStore } from "./ledger.ts";
import type { Connector, Driver } from "./op.ts";
import type { Policy } from "./policy.ts";

/**
 * What a worker runs, with which drivers, under which policy: the argument to `startWorker`.
 * A project usually keeps it in `sanoma.config.ts` and passes it in; nothing loads that file automatically.
 */
export interface SanomaConfig {
  workflows: WorkflowDefinition<any, any>[];
  /**
   * The connectors (from `defineConnector`) whose operations the drivers implement. The worker
   * takes each operation's effect, schemas and retry setting from here, not from the workflow,
   * and refuses a workflow that declares an operation differently.
   */
  connectors: Connector<any, any>[];
  drivers: Driver[];
  /** Checked before every operation call. Without one, every call is allowed. */
  policy?: Policy;
  /** Where the audit record goes. Defaults to an in-memory store, which a separate client cannot read. */
  ledger?: LedgerStore;
  /** Scopes workflows and queues in the system database. Defaults to "sanoma". */
  appName?: string;
  /** Postgres for the runtime. Defaults to `SANOMA_DATABASE_URL`, then the local docker compose database. */
  databaseUrl?: string;
}

export const DEFAULT_DATABASE_URL = "postgresql://postgres:dbos@localhost:5433/sanoma";

export function defineConfig(config: SanomaConfig): SanomaConfig {
  return config;
}

export function resolveDatabaseUrl(config: { databaseUrl?: string }): string {
  return config.databaseUrl ?? process.env.SANOMA_DATABASE_URL ?? DEFAULT_DATABASE_URL;
}
