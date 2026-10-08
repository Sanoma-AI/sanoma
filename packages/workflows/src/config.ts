import type { Use, WorkflowDefinition } from "./define.ts";
import type { LedgerStore } from "./ledger.ts";
import { type Connector, type Driver, type DriverFn, isOp, type Op } from "./op.ts";
import type { Policy } from "./policy.ts";
import { computeVersion } from "./version.ts";

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
  /** Checked before every operation call. Required: `allowAll` says that every call is allowed. */
  policy: Policy;
  /**
   * Where the audit record goes. Required: `jsonlLedger(dir)` keeps it in files that the app
   * and other processes read; `memoryLedger()` keeps it in this process only, for tests.
   */
  ledger: LedgerStore;
  /** Scopes workflows, queues and versions in the system database. Defaults to "sanoma". */
  appName?: string;
  /** Postgres for the runtime. Defaults to `SANOMA_DATABASE_URL`, then the local docker compose database. */
  databaseUrl?: string;
}

/** A config, checked, with everything a worker, client or app derives from it. */
export interface ResolvedConfig {
  appName: string;
  databaseUrl: string;
  /** The DBOS application version: `<appName>@<DBOS__APPVERSION, or a hash of the workflows>`. */
  version: string;
  /** The DBOS queue runs are started on: `sanoma:<appName>`. */
  queueName: string;
  /** The operations the connectors declare, by id. */
  ops: Map<string, Op>;
  /** The drivers' functions, by operation id. */
  drivers: Map<string, DriverFn>;
  /** Each checked against `ops` and `drivers`; names are unique. */
  workflows: WorkflowDefinition<any, any>[];
  policy: Policy;
  ledger: LedgerStore;
}

export const DEFAULT_DATABASE_URL = "postgresql://postgres:dbos@localhost:5433/sanoma";

export function defineConfig(config: SanomaConfig): SanomaConfig {
  return config;
}

export function resolveDatabaseUrl(config: { databaseUrl?: string }): string {
  return config.databaseUrl ?? process.env.SANOMA_DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

/**
 * Checks a config and derives what the runtime needs from it. Throws what `startWorker` would
 * refuse, with the same message, so `describeConfig`, `SanomaClient.connect` and the app fail
 * the same way the worker does.
 */
export function resolveConfig(config: SanomaConfig): ResolvedConfig {
  if (!Array.isArray(config.connectors)) {
    throw new Error(
      "The config needs `connectors`: the defineConnector objects whose operations the drivers implement",
    );
  }
  if (!Array.isArray(config.workflows)) {
    throw new Error("The config needs `workflows`: an array of defineWorkflow definitions");
  }
  if (!Array.isArray(config.drivers)) {
    throw new Error("The config needs `drivers`: an array of defineDriver implementations");
  }
  if (typeof config.policy !== "function") {
    throw new Error("The config needs a `policy`; use `allowAll` to allow every operation call");
  }
  const { ledger } = config;
  if (typeof ledger?.append !== "function" || typeof ledger.read !== "function") {
    throw new Error(
      "The config needs a `ledger`; use `jsonlLedger(dir)` to keep records in files, or `memoryLedger()` to keep them in memory, for tests",
    );
  }
  const appName = config.appName ?? "sanoma";
  const ops = indexConnectors(config.connectors);
  const drivers = indexDrivers(config.drivers, ops);
  const names = new Map<string, WorkflowDefinition<any, any>>();
  for (const wf of config.workflows) {
    checkUses(wf, ops, drivers);
    const other = names.get(wf.name);
    if (other && other !== wf) {
      throw new Error(
        `Two different workflow definitions are named "${wf.name}"; a name can be registered once per process`,
      );
    }
    names.set(wf.name, wf);
  }
  return {
    appName,
    databaseUrl: resolveDatabaseUrl(config),
    version: computeVersion(config),
    queueName: `sanoma:${appName}`,
    ops,
    drivers,
    workflows: [...names.values()],
    policy: config.policy,
    ledger,
  };
}

function indexConnectors(list: Connector<any, any>[]) {
  const map = new Map<string, Op>();
  for (const connector of list) {
    for (const resource of Object.values(connector as Record<string, Record<string, unknown>>)) {
      for (const op of Object.values(resource)) {
        if (!isOp(op)) continue;
        const seen = map.get(op.id);
        if (seen && seen !== op) throw new Error(`Two connectors in \`connectors\` declare ${op.id}`);
        map.set(op.id, op);
      }
    }
  }
  return map;
}

function indexDrivers(list: Driver[], ops: Map<string, Op>) {
  const map = new Map<string, DriverFn>();
  for (const d of list) {
    for (const [key, fn] of Object.entries(d.ops)) {
      const id = `${d.vendor}.${key}`;
      if (!ops.has(id)) {
        throw new Error(`Driver "${d.vendor}" implements ${id}, which no connector in \`connectors\` declares`);
      }
      map.set(id, fn);
    }
  }
  return map;
}

/**
 * Every operation a workflow uses must be one the config's connectors declare, with a driver.
 * The workflow normally imports the same connector object; a copy is accepted only if it
 * declares the same effect and retry setting, and the worker's declaration is used either way.
 */
function checkUses(wf: WorkflowDefinition<any, any>, ops: Map<string, Op>, impls: Map<string, unknown>) {
  const problems: string[] = [];
  for (const op of (wf.uses as readonly Use[]).filter(isOp)) {
    const known = ops.get(op.id);
    if (!known) problems.push(`${op.id} is not declared by any connector in \`connectors\``);
    else if (known !== op && (known.effect !== op.effect || known.idempotent !== op.idempotent)) {
      problems.push(
        `${op.id} is declared with effect "${op.effect}"${op.idempotent ? " (idempotent)" : ""}, ` +
          `but its connector says "${known.effect}"${known.idempotent ? " (idempotent)" : ""}`,
      );
    } else if (!impls.has(op.id)) problems.push(`${op.id} has no driver`);
  }
  if (problems.length) throw new Error(`Workflow "${wf.name}": ${problems.join("; ")}`);
}
