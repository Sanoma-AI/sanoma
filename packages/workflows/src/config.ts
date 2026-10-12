import { existsSync, readFileSync } from "node:fs";
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
  type Driver,
  DriverError,
  type DriverEnv,
  type DriverFn,
  isOp,
  type Op,
  setupOf,
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
   * connector's package attaches; a sandbox run calls its own copy (`fresh()`) of the fake.
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
}

/** A config, checked, with everything a worker, client or app derives from it. */
export interface ResolvedConfig {
  /**
   * Scopes workflows, queues and versions in the system database: the `name` of the nearest
   * `package.json` at or above `root` that has one, else "sanoma".
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
  /** The drivers the connectors attach, in `connectors` order: what the credentials are read from (`credentialsOf`). */
  driverList: readonly Driver[];
  /**
   * The fakes the connectors attach, by vendor id: the templates each sandbox run copies. Made
   * once per config object, so every resolution of one config gives the same instances.
   */
  fakes: Map<string, Fake<any, any>>;
  /** The fakes' functions, by operation id: which operations a sandbox run has a fake for. */
  fakeDrivers: Map<string, DriverFn>;
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

/** What a config held before its connectors carried their drivers and fakes, and where each went. */
const REMOVED: Record<string, string> = {
  drivers: "each connector carries its driver",
  fakes: "each connector carries its fake",
  appName: "the app's name is its package.json's",
  scenarios: "the scenarios are `scenarios/` in the config's root",
};

/**
 * Checks a config and derives what the runtime needs from it: the drivers and fakes from the
 * connectors' setups (`withSetup`), and from `root`, the app's name (`package.json`) and the
 * scenarios (`scenarios/`). Throws what `startWorker` would refuse, with the same message, so
 * `describeConfig`, `SanomaClient.connect` and the app fail the same way the worker does. It
 * opens nothing, reads no file outside `root` but a `package.json` above it, and is called per
 * request by the app.
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
  // A config still naming fake drivers would otherwise run live: refuse it rather than ignore them.
  const removed = Object.keys(REMOVED).filter(
    (key) => (config as object as Record<string, unknown>)[key] !== undefined,
  );
  if (removed.length) {
    throw new Error(
      `The config's ${removed.map((key) => `\`${key}\``).join(", ")} ${removed.length > 1 ? "are" : "is"} no longer read; ` +
        `leave ${removed.length > 1 ? "them" : "it"} out: ${removed.map((key) => REMOVED[key]).join("; ")}`,
    );
  }
  const ledger = ledgerOf(config);
  // No fallback to the working directory: a config found nowhere has no data files, and says so.
  const root =
    config.root !== undefined ? resolve(config.root) : config.file !== undefined ? dirname(config.file) : undefined;
  const appName = appNameAt(root);
  const scenarios = root !== undefined && existsSync(join(root, "scenarios")) ? scenariosAt(root) : undefined;
  const ops = indexConnectors(config.connectors);
  const driverList = config.connectors.flatMap((c) => setupOf(c)?.driver() ?? []);
  const drivers = indexDrivers(driverList, ops);
  const fakes = fakesOf(config);
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
    version: computeVersion({ appName, workflows: [...names.values()] }),
    queueName: `sanoma:${appName}`,
    ops,
    drivers,
    driverList,
    fakes,
    fakeDrivers,
    ...(scenarios && { scenarios }),
    types,
    workflows: names,
    policy: config.policy,
    ...(ledger !== undefined && { ledger }),
    ...(root !== undefined && { root }),
  };
}

/** The fakes the connectors attach, by vendor, made on a config's first resolution and kept for the config object. */
const fakesByConfig = new WeakMap<SanomaConfig, Map<string, Fake<any, any>>>();

function fakesOf(config: SanomaConfig): Map<string, Fake<any, any>> {
  const known = fakesByConfig.get(config);
  if (known) return known;
  const fakes = new Map<string, Fake<any, any>>();
  for (const connector of config.connectors) {
    const fake = setupOf(connector)?.fake();
    if (fake === undefined) continue;
    const { vendor } = fake.driver;
    const seen = fakes.get(vendor);
    if (seen && seen !== fake) {
      throw new Error(`Two connectors in \`connectors\` attach a fake for "${vendor}"; keep one per vendor`);
    }
    fakes.set(vendor, fake);
  }
  fakesByConfig.set(config, fakes);
  return fakes;
}

/** `scenarios/` in `root`, as a `file:` URL to the directory (with its trailing slash). */
const scenariosAt = (root: string) => pathToFileURL(`${join(root, "scenarios")}/`);

/** Each directory's app name, once read: a `package.json` changes with a restart, not per request. */
const appNames = new Map<string, string>();

/**
 * The `name` of the nearest `package.json` at or above `root` that has one, kept whole (`@acme/ops`),
 * else "sanoma", as for a config with no `root`.
 */
function appNameAt(root: string | undefined): string {
  if (root === undefined) return "sanoma";
  const known = appNames.get(root);
  if (known !== undefined) return known;
  let name = "sanoma";
  for (let dir = root; ;) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      let manifest: unknown;
      try {
        manifest = JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        throw new Error(`${file} is not JSON, so it names no app: ${(err as Error).message}`, { cause: err });
      }
      const named = (manifest as { name?: unknown } | null)?.name;
      if (typeof named === "string" && named.trim()) {
        name = named.trim();
        break;
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  appNames.set(root, name);
  return name;
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
