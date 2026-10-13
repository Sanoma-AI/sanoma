import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { callerFile, type Use, type WorkflowDefinition } from "./define.ts";
import { DRIFT_WORKFLOW, type DriftDeclared, driftWorkflow } from "./drift.ts";
import { statusesOf, unconfigured } from "./env.ts";
import type { Fake } from "./fake.ts";
import type { LedgerStore } from "./ledger.ts";
import {
  type Connector,
  type ConnectorSetup,
  type Driver,
  DriverError,
  type DriverEnv,
  type DriverFn,
  isOp,
  type Op,
  setupOf,
  VENDOR,
} from "./op.ts";
import type { Policy } from "./policy.ts";
import { type Resource, resourceTypesOf, withoutWriteOnly } from "./resource.ts";
import { computeVersion } from "./version.ts";

/**
 * What a worker runs, on which connectors, under which policy: the argument to `startWorker`.
 * A project usually keeps it in `sanoma.config.ts` and passes it in; nothing loads that file
 * automatically. The rest is convention: each connector carries its driver and its fake
 * (`withSetup`), the app's name is its `package.json`'s, and the scenarios and data files are
 * `scenarios/` and `resources/` in `root`.
 */
export interface SanomaConfig {
  workflows: WorkflowDefinition<any, any>[];
  /**
   * The connectors (from `defineConnector`, as their packages export them). The worker takes
   * each operation's effect, schemas and retry setting from here, not from the workflow, and
   * refuses a workflow that declares an operation differently. A live run calls the driver its
   * connector's package attaches; a sandbox run calls a fake of its own, which the connector's
   * package attaches the maker of.
   */
  connectors: Connector<any, any>[];
  /** Checked before every operation call. Required: `allowAll` says that every call is allowed. */
  policy: Policy;
  /**
   * Where the audit record goes. Default: `postgresLedger` on the config's database, which the
   * worker, the app and other processes share; the worker and the client each make their own
   * and close it with themselves. A store given here is never closed by the runtime.
   * `jsonlLedger(dir)` keeps it in files instead; `memoryLedger()` keeps it in this process
   * only, for tests.
   */
  ledger?: LedgerStore;
  /** Postgres for the runtime. Defaults to `SANOMA_DATABASE_URL`, then the local docker compose database. */
  databaseUrl?: string;
  /** The file that defined the config, absolute, when known. Set by `defineConfig` from its call site. */
  file?: string;
  /**
   * The directory the config's conventions are relative to: its `package.json` (the app's name),
   * `scenarios/` and `resources/`. Defaults to `file`'s directory; set it where that is not the
   * source's, as in a bundle.
   */
  root?: string;
  /** @deprecated Gone: each connector carries its driver (`withSetup`, from its package). Leave it out. */
  drivers?: never;
  /** @deprecated Gone: each connector carries the maker of its fake (`withSetup`, from its package). Leave it out. */
  fakes?: never;
  /** @deprecated Gone: the app's name is the `name` in `<root>/package.json`, else "sanoma". Leave it out. */
  appName?: never;
  /** @deprecated Gone: the scenarios are `<root>/scenarios/`. Leave it out. */
  scenarios?: never;
}

/** A config, checked, with everything a worker, client or app derives from it. */
export interface ResolvedConfig {
  /**
   * Scopes workflows, queues and versions in the system database: the `name` of
   * `<root>/package.json` when it names one, else "sanoma".
   */
  appName: string;
  databaseUrl: string;
  /** The DBOS application version: `<appName>@<DBOS__APPVERSION, or a hash of the workflows>`. */
  version: string;
  /** The DBOS queue runs are started on: `sanoma:<appName>`. */
  queueName: string;
  /** The operations the connectors declare, by id. */
  ops: Map<string, Op>;
  /** The drivers' functions, by operation id, each guarded by its driver's `env` (`indexDrivers`). */
  drivers: Map<string, DriverFn>;
  /**
   * The driver each vendor's connector attaches, made once for this resolution, by vendor id in
   * `connectors` order: what `drivers` indexes and the credentials are read from (`credentialsOf`).
   */
  driversByVendor: Map<string, Driver>;
  /** The makers of the fakes the connectors attach, by vendor id in `connectors` order: each sandbox run makes its own. */
  fakes: Map<string, () => Fake<any, any>>;
  /** `scenarios/` in `root`, as a `file:` URL, when that directory exists. */
  scenarios?: URL;
  /** The resource types the connectors declare, by `<vendor>.<type>`: what the drift workflow checks and scenarios seed. */
  types: ReadonlyMap<string, Resource>;
  /**
   * By name; each checked against `ops` and `drivers`. The config's, and the built-in `drift`
   * (`DRIFT_WORKFLOW`) when its connectors declare resource types.
   */
  workflows: Map<string, WorkflowDefinition<any, any>>;
  policy: Policy;
  /** The config's `ledger`, when it gives one; the worker and the client otherwise make `postgresLedger` on `databaseUrl` (`ownedLedger`). */
  ledger?: LedgerStore;
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

export function resolveDatabaseUrl(config: { databaseUrl?: string }, env: NodeJS.ProcessEnv = process.env): string {
  return config.databaseUrl ?? env.SANOMA_DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

const isStore = (x: unknown): x is LedgerStore =>
  typeof (x as LedgerStore | null)?.append === "function" && typeof (x as LedgerStore).read === "function";

/** The config's `ledger`, checked, when it gives one. */
function ledgerOf(config: SanomaConfig): LedgerStore | undefined {
  if (config.ledger !== undefined && !isStore(config.ledger)) {
    throw new Error(
      "The config's `ledger` must be a ledger store: leave it out for `postgresLedger` on the config's database, " +
        "or use `jsonlLedger(dir)` to keep records in files, or `memoryLedger()` to keep them in memory, for tests",
    );
  }
  return config.ledger;
}

/**
 * The config's directory, absolute: its `root`, else its `file`'s directory; undefined when it
 * has neither. No fallback to the working directory: a config found nowhere has no data files,
 * and says so. What a read that needs only the root calls, rather than `resolveConfig`.
 */
export function rootOf(config: Pick<SanomaConfig, "root" | "file">): string | undefined {
  return config.root !== undefined
    ? resolve(config.root)
    : config.file !== undefined
      ? dirname(config.file)
      : undefined;
}

/**
 * Checks a config and derives what the runtime needs from it: the drivers and fakes from the
 * connectors' setups (`withSetup`), and from `root`, the app's name (`package.json`) and the
 * scenarios (`scenarios/`). Throws what `startWorker` would refuse, with the same message, so
 * `describeConfig`, `SanomaClient.connect` and the app fail the same way the worker does. It
 * opens nothing and reads no file outside `root`. Each entry
 * point resolves once: the worker and the client when they start, the app at `startApp`, the
 * `sanoma` bin when it loads the config.
 */
export function resolveConfig(config: SanomaConfig): ResolvedConfig {
  if (!Array.isArray(config.connectors)) {
    throw new Error("The config needs `connectors`: the connectors its workflows call, as their packages export them");
  }
  if (!Array.isArray(config.workflows)) {
    throw new Error("The config needs `workflows`: an array of defineWorkflow definitions");
  }
  if (typeof config.policy !== "function") {
    throw new Error("The config needs a `policy`; use `allowAll` to allow every operation call");
  }
  // An untyped config naming fake drivers would otherwise run live. Delete once sanoma-ops has migrated.
  if (config.drivers !== undefined || config.fakes !== undefined)
    throw new Error(
      "The config's `drivers` and `fakes` are gone: each connector carries its driver and its fake; leave them out",
    );
  const ledger = ledgerOf(config);
  const root = rootOf(config);
  const appName = appNameAt(root);
  const scenarios = scenariosAt(root);
  const ops = indexConnectors(config.connectors);
  const driversByVendor = new Map([...makersOf(config.connectors, "driver")].map(([vendor, make]) => [vendor, make()]));
  const drivers = indexDrivers([...driversByVendor.values()], ops);
  const fakes = makersOf(config.connectors, "fake");
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
    version: computeVersion({ appName, workflows: [...names.values()] }),
    queueName: `sanoma:${appName}`,
    ops,
    drivers,
    driversByVendor,
    fakes,
    ...(scenarios && { scenarios }),
    types,
    workflows: names,
    policy: config.policy,
    ...(ledger !== undefined && { ledger }),
    ...(root !== undefined && { root }),
  };
}

/**
 * What the connectors' setups attach under `key` (`withSetup`), by vendor id in `connectors`
 * order. One vendor's connectors may name one maker, as copies of one connector do, never two.
 */
function makersOf<K extends keyof ConnectorSetup>(
  connectors: readonly Connector<any, any>[],
  key: K,
): Map<string, NonNullable<ConnectorSetup[K]>> {
  const makers = new Map<string, NonNullable<ConnectorSetup[K]>>();
  for (const connector of connectors) {
    const make = setupOf(connector)[key];
    if (make === undefined) continue;
    const vendor = connector[VENDOR].id;
    const seen = makers.get(vendor);
    if (seen && seen !== make) {
      throw new Error(`Two connectors in \`connectors\` attach a ${key} for "${vendor}"; keep one per vendor`);
    }
    makers.set(vendor, make);
  }
  return makers;
}

/**
 * The `name` of `<root>/package.json`, kept whole (`@acme/ops`), when that file exists and names
 * one; else "sanoma", as for a config with no `root`. Never a `package.json` above the root: a
 * parent project's name must not become the app's. A file that is not JSON is refused, naming it.
 */
function appNameAt(root: string | undefined): string {
  const file = root === undefined ? undefined : join(root, "package.json");
  if (file === undefined || !existsSync(file)) return "sanoma";
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not JSON, so it names no app: ${(err as Error).message}`, { cause: err });
  }
  const named = (manifest as { name?: unknown } | null)?.name;
  return typeof named === "string" && named.trim() ? named.trim() : "sanoma";
}

/** `<root>/scenarios/`, as a `file:` URL to the directory (with its trailing slash), when it is a directory. */
function scenariosAt(root: string | undefined): URL | undefined {
  const dir = root === undefined ? undefined : join(root, "scenarios");
  if (dir === undefined || !statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return undefined;
  return pathToFileURL(`${dir}/`);
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

/**
 * The drivers' functions by operation id, refusing one no connector declares. A driver that
 * declares an `env` has each function guarded by it (`guarded`); a fake declares none, so a
 * sandbox run's calls are not.
 */
export function indexDrivers(list: Driver[], ops: Map<string, Op>) {
  const map = new Map<string, DriverFn>();
  for (const d of list) {
    for (const [key, fn] of Object.entries(d.ops)) {
      const id = `${d.vendor}.${key}`;
      if (!ops.has(id)) {
        throw new Error(`Driver "${d.vendor}" implements ${id}, which no connector in \`connectors\` declares`);
      }
      map.set(id, d.env ? guarded(d.vendor, d.env, fn) : fn);
    }
  }
  return map;
}

/**
 * `fn`, refused while the environment leaves a variable `env` declares missing or invalid. The
 * worker started without it (`startWorker` only warns), and stored credentials load into the
 * environment as they are set, so the check is made when the function is called, inside the
 * driver step, and nowhere earlier: not at start, and not before the policy's decision or an
 * approval hold, so a credential set on the connector page while a call waits for approval is
 * used when the approver approves. The refusal is the call's own failure, final: recorded as
 * the call's, and never retried.
 */
function guarded(vendor: string, env: DriverEnv, fn: DriverFn): DriverFn {
  return async (input, call) => {
    const why = unconfigured(
      vendor,
      statusesOf(env, (name) => process.env[name]),
    );
    if (why) throw new DriverError(why, { retryable: false });
    return fn(input, call);
  };
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
    } else if (!impls.has(op.id)) {
      problems.push(`\`${op.id}\` has no driver: the connector package must attach one`);
    }
  }
  if (problems.length) throw new Error(`Workflow "${wf.name}": ${problems.join("; ")}`);
}
