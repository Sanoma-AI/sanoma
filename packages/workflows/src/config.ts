import { dirname, resolve } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { z } from "zod";
import { callerFile, type Use, type WorkflowDefinition } from "./define.ts";
import { DRIFT_WORKFLOW, type DriftDeclared, driftWorkflow } from "./drift.ts";
import type { Fake } from "./fake.ts";
import type { LedgerStore } from "./ledger.ts";
import { type Connector, type Driver, type DriverEnv, type DriverFn, isOp, type Op } from "./op.ts";
import type { Policy } from "./policy.ts";
import { type Resource, resourceTypesOf, withoutWriteOnly } from "./resource.ts";
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
  /**
   * Fake vendors (from `defineFake`) that sandbox runs call instead of the drivers. A sandbox
   * run is started with `{ sandbox: "<scenario name>" }` and seeded from that scenario.
   */
  fakes?: Fake<any, any>[];
  /** The directory of `.feature` files sandbox runs are seeded from, as a `file:` URL, such as `new URL("./scenarios/", import.meta.url)`. */
  scenarios?: URL;
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
  /** The file that defined the config, absolute, when known. Set by `defineConfig` from its call site. */
  file?: string;
  /**
   * The directory the config's conventions are relative to: the data files are `resources/`
   * in it. Defaults to `file`'s directory; set it where that is not the source's, as in a bundle.
   */
  root?: string;
}

/** One environment variable a driver declares in `env`: its name and manual, never a value. */
export interface CredentialDeclaration {
  /** The variable's name, such as `GHOST_ADMIN_API_KEY`. */
  name: string;
  /** Its one-line manual, from its schema's `.describe()`. */
  description?: string;
  /** It may be unset. */
  optional: boolean;
}

/** A declared variable and whether its value lets the driver run: never the value. */
export interface CredentialStatus extends CredentialDeclaration {
  /** `missing` when unset or empty; `invalid` when its schema refuses the value. */
  status: "set" | "missing" | "invalid";
  /** Why it is `invalid`: the schema's first issue, never the value. */
  problem?: string;
  /**
   * Where the value is from, when there is one: the process environment, which wins, or the
   * credentials stored with `SanomaClient.setCredential`. Only `SanomaClient.credentials` says.
   */
  source?: "environment" | "stored";
  /** Who set the stored value (`setCredential`'s `by`). */
  setBy?: string;
  /** When the stored value was set, as an ISO 8601 time. */
  setAt?: string;
}

/** A config, checked, with everything a worker, client or app derives from it. */
export interface ResolvedConfig {
  appName: string;
  databaseUrl: string;
  /** The DBOS application version: `<appName>@<DBOS__APPVERSION, or a hash of the workflows>`. */
  version: string;
  /** The DBOS queue runs are started on: `sanoma:<appName>`. */
  queueName: string;
  /** The DBOS queue sandbox runs are started on, which runs one at a time per worker: `sanoma:<appName>:sandbox`. */
  sandboxQueueName: string;
  /** The operations the connectors declare, by id. */
  ops: Map<string, Op>;
  /** The drivers' functions, by operation id. */
  drivers: Map<string, DriverFn>;
  /** The fake vendors sandbox runs call, by vendor id. */
  fakes: Map<string, Fake<any, any>>;
  /** The fakes' functions, by operation id: what a sandbox run calls. */
  fakeDrivers: Map<string, DriverFn>;
  /** The scenarios directory, a `file:` URL. */
  scenarios?: URL;
  /**
   * By name; each checked against `ops` and `drivers`. The config's, and the built-in `drift`
   * (`DRIFT_WORKFLOW`) when its connectors declare resource types.
   */
  workflows: Map<string, WorkflowDefinition<any, any>>;
  policy: Policy;
  ledger: LedgerStore;
  /**
   * The environment variables each driver declares in `env`, by vendor, in declared order, as
   * `process.env` held them when the config was resolved, without the stored credentials
   * (`SanomaClient.credentials` reads both). A vendor whose drivers declare none has no entry.
   */
  credentials: Map<string, CredentialStatus[]>;
  /**
   * The config's directory, absolute: its `root`, else its `file`'s directory. Its data files
   * are `resources/` in it. Absent when the config has neither, so it has no data files.
   */
  root?: string;
}

export const DEFAULT_DATABASE_URL = "postgresql://postgres:dbos@localhost:5433/sanoma";

/** Returns the config, with the file it is called from as its `file`: its directory is the config's `root`. */
export function defineConfig(config: SanomaConfig): SanomaConfig {
  return { ...config, file: config.file ?? callerFile() };
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
  if (config.fakes !== undefined && !Array.isArray(config.fakes)) {
    throw new Error("The config's `fakes` must be an array of defineFake fakes");
  }
  const { scenarios } = config;
  if (scenarios !== undefined && !(scenarios instanceof URL && scenarios.protocol === "file:")) {
    throw new Error(
      'The config\'s `scenarios` must be a file: URL to a directory, such as new URL("./scenarios/", import.meta.url)',
    );
  }
  const appName = config.appName ?? "sanoma";
  // No fallback to the working directory: a config found nowhere has no data files, and says so.
  const root =
    config.root !== undefined ? resolve(config.root) : config.file !== undefined ? dirname(config.file) : undefined;
  const ops = indexConnectors(config.connectors);
  const drivers = indexDrivers(config.drivers, ops);
  const fakes = new Map<string, Fake<any, any>>();
  for (const fake of config.fakes ?? []) {
    const { vendor } = fake.driver;
    if (fakes.has(vendor)) throw new Error(`Two fakes in \`fakes\` are for "${vendor}"; keep one per vendor`);
    fakes.set(vendor, fake);
  }
  const fakeDrivers = indexDrivers(
    [...fakes.values()].map((f) => f.driver),
    ops,
  );
  const names = new Map<string, WorkflowDefinition<any, any>>();
  for (const wf of config.workflows) {
    if (wf.name === DRIFT_WORKFLOW) {
      throw new Error(
        `A workflow is named "${DRIFT_WORKFLOW}", the name of the built-in drift workflow; name it otherwise`,
      );
    }
    checkUses(wf, ops, drivers);
    const other = names.get(wf.name);
    if (other && other !== wf) {
      throw new Error(
        `Two different workflow definitions are named "${wf.name}"; a name can be registered once per process`,
      );
    }
    names.set(wf.name, wf);
  }
  // Built-in: checking the resources the data files declare against their vendors.
  const types = resourceTypesOf(config.connectors);
  if (types.size) {
    const declared = () =>
      DBOS.runStep(() => readDeclared(root, config.connectors, types), { name: "drift:data-files" });
    names.set(DRIFT_WORKFLOW, driftWorkflow(types, ops, drivers, declared));
  }
  return {
    appName,
    databaseUrl: resolveDatabaseUrl(config),
    // The built-in's code and operations are part of the app's version, like the config's own.
    version: computeVersion({ appName: config.appName, workflows: [...names.values()] }),
    queueName: `sanoma:${appName}`,
    sandboxQueueName: `sanoma:${appName}:sandbox`,
    ops,
    drivers,
    fakes,
    fakeDrivers,
    ...(scenarios && { scenarios }),
    workflows: names,
    policy: config.policy,
    ledger,
    credentials: credentialsOf(config.drivers, (name) => process.env[name]),
    ...(root !== undefined && { root }),
  };
}

/**
 * Each driver's `env`, by vendor, each variable checked against the value `lookup` gives for its
 * name: only the declared names are looked up, an empty value counts as unset, and a value is
 * never kept. A variable two drivers of one vendor declare is checked against each declaration,
 * and the results merged.
 */
export function credentialsOf(
  drivers: readonly Driver[],
  lookup: (name: string) => string | undefined,
): Map<string, CredentialStatus[]> {
  const map = new Map<string, CredentialStatus[]>();
  for (const { vendor, env } of drivers) {
    if (!env) continue;
    const list = map.get(vendor) ?? [];
    map.set(vendor, list);
    for (const [name, schema] of Object.entries(env.shape)) {
      const status = credentialStatus(name, schema, lookup(name) || undefined);
      const i = list.findIndex((c) => c.name === name);
      if (i === -1) list.push(status);
      else list[i] = merged(list[i]!, status);
    }
  }
  return map;
}

const SEVERITY: Record<CredentialStatus["status"], number> = { set: 0, missing: 1, invalid: 2 };

/**
 * Two declarations of one variable: the worse status (`invalid`, then `missing`) with its problem,
 * the first description, and optional only when both allow it unset.
 */
function merged(first: CredentialStatus, next: CredentialStatus): CredentialStatus {
  const worse = SEVERITY[next.status] > SEVERITY[first.status] ? next : first;
  const description = first.description ?? next.description;
  return { ...worse, ...(description !== undefined && { description }), optional: first.optional && next.optional };
}

function credentialStatus(
  name: string,
  schema: DriverEnv["shape"][string],
  value: string | undefined,
): CredentialStatus {
  const description = descriptionOf(schema);
  const parsed = value === undefined ? undefined : check(schema, value);
  const problem = parsed?.problem;
  return {
    name,
    ...(description !== undefined && { description }),
    optional: check(schema, undefined).success,
    status: !parsed ? "missing" : parsed.success ? "set" : "invalid",
    ...(problem !== undefined && { problem }),
  };
}

/**
 * `schema.safeParse(value)`, with its first issue's message as the problem. A check that throws
 * (zod lets a `.refine()` or `.transform()` throw) fails without its error, which may carry the value.
 */
function check(schema: z.ZodType, value: string | undefined): { success: boolean; problem?: string } {
  try {
    const { success, error } = schema.safeParse(value);
    return { success, ...(error && { problem: error.issues[0]!.message }) };
  } catch {
    return { success: false, problem: "its check threw" };
  }
}

/** A schema's `.describe()`, also through `.optional()`, `.default()` and `.prefault()` in any order. */
function descriptionOf(schema: z.ZodType): string | undefined {
  let s: z.ZodType | undefined = schema;
  while (s && !s.description) s = "unwrap" in s ? (s as { unwrap(): z.ZodType }).unwrap() : undefined;
  return s?.description;
}

/**
 * The data files under `root`, as a drift run records them: each resource without its write-only
 * values, which a run never compares and never records, and the problems.
 */
async function readDeclared(
  root: string | undefined,
  connectors: readonly Connector<any, any>[],
  types: ReadonlyMap<string, Resource>,
): Promise<DriftDeclared> {
  // Loaded when a drift run reads the files, not with the worker: the reader parses with oxc-parser.
  const { readDataFiles } = await import("./resources.ts");
  const { resources, problems } = readDataFiles(root, connectors, types);
  return {
    resources: resources.map(({ id, vendor, type, name, desired, refs }) => ({
      id,
      vendor,
      type,
      name,
      desired: withoutWriteOnly(types.get(`${vendor}.${type}`)!.fields, desired),
      refs,
    })),
    problems,
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
