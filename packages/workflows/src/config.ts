import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { type ApplyDeclared, applyWorkflow } from "./apply.ts";
import { applySteps } from "./apply-steps.ts";
import { callWorkflow } from "./call-workflow.ts";
import { changeDriver, changeOps, reservedFor } from "./change.ts";
import {
  type Collection,
  collectionsConnector,
  collectionsDriver,
  collectionsFake,
  isCollection,
} from "./collection.ts";
import { lazyPool, type LazyPool } from "./db.ts";
import { isDirectory, kindDirs, SCENARIOS_DIR } from "./paths.ts";
import { callerFile, type Use, type WorkflowDefinition } from "./define.ts";
import { DRIFT_WORKFLOW, driftWorkflow } from "./drift.ts";
import { statusesOf, unconfigured } from "./env.ts";
import { type Fake, fakeSanomaWakeup } from "./fake.ts";
import { peopleConnector } from "./person.ts";
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
  checkConnector,
  setupOf,
  VENDOR,
  withSetup,
} from "./op.ts";
import { type CedarPolicySource, policyAt } from "./cedar.ts";
import type { Policy } from "./policy.ts";
import { type Resource, resourceTypesOf, withoutWriteOnly } from "./resource.ts";
import { APPLY_WORKFLOW, BUILT_IN_WORKFLOWS, CALL_WORKFLOW, DATA_VENDOR } from "./shared.ts";
import { type RemoteHalf, sourceDriver, sourceOps } from "./source.ts";
import type { Steps } from "./steps.ts";
import { checkSchedule } from "./schedules.ts";
import { computeVersion } from "./version.ts";
import type { DeclaredResource } from "./resources.ts";
import { checkWakeupOps, type DeclaredWakeup } from "./wakeup.ts";
import { sanomaWakeupDriver, wakeupSteps } from "./wakeup-driver.ts";
import { wakeupOps } from "./wakeup-type.ts";
import { checkDatabaseOps } from "./database.ts";

/**
 * What a worker runs, on which connectors: the argument to `startWorker`.
 * A project usually keeps it in `sanoma.config.ts` and passes it in; nothing loads that file
 * automatically. The rest is convention: each connector carries its driver and its fake
 * (`withSetup`), the app's name is its `package.json`'s, and the scenarios, data files and
 * policies are `scenarios/`, `resources/` and `policies/` in `root`.
 */
export interface SanomaConfig {
  /**
   * Workflows besides those the launcher finds (`sanoma` imports every file of `workflows/` and
   * each app's `apps/<app>/workflows/`): listing one it finds as well is no second one.
   */
  workflows?: WorkflowDefinition<any, any>[];
  /**
   * The connectors (from `defineConnector`, as their packages export them). The worker takes
   * each operation's effect, schemas and retry setting from here, not from the workflow, and
   * refuses a workflow that declares an operation differently. A live run calls the driver its
   * connector's package attaches; a sandbox run calls a fake of its own, which the connector's
   * package attaches the maker of.
   */
  connectors: Connector<any, any>[];
  /**
   * Where the audit record goes. Default: `postgresLedger` on the config's database, which the
   * worker, the app and other processes share; the worker and the client each make their own
   * and close it with themselves. A store given here is never closed by the runtime.
   * `jsonlLedger(dir)` keeps it in files instead; `memoryLedger()` keeps it in this process
   * only, for tests.
   */
  ledger?: LedgerStore;
  /** Postgres for the runtime. Defaults to `SANOMA_DATABASE_URL`, then `DEFAULT_DATABASE_URL`. */
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
  /** @deprecated Gone: the policy is `<root>/policies/**\/*.cedar`. Leave it out. */
  policy?: never;
  /** The company's own steps for its scenarios (`defineSteps`), besides those its connectors ship. */
  steps?: Steps[];
  /**
   * The company's collections (`collection()`): their operations are `data.<name>.<op>`, their
   * records in the config's database, and in memory for a sandbox run.
   */
  collections?: readonly Collection[];
  /**
   * Run the wakeup service inside this instance (`sanoma serve`), for other instances' wakeups
   * to register with. An instance that runs it must not stop, so `startWorker` refuses a config
   * that sets it and declares a wakeup of its own.
   */
  wakeup?: true;
  /**
   * What the app says when it runs this repo as a demo (`sanoma demo`): `start`, the URL its
   * banner's "Start with these apps" opens, such as the hosted wizard with the demo's apps
   * chosen; without one, the banner has no such link.
   */
  demo?: { start?: string };
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
  /**
   * The operations the connectors declare, by id, the built-in `sanoma.change.*` (`changeOps`, in
   * every config), `sanoma.source.resolve` and `sanoma.wakeup`'s when one declares a host type,
   * and the collections' (`data.<name>.<op>`).
   */
  ops: Map<string, Op>;
  /** The drivers' functions, by operation id, each guarded by its driver's `env` (`indexDrivers`). */
  drivers: Map<string, DriverFn>;
  /**
   * The driver each vendor's connector attaches, made once for this resolution, by vendor id in
   * `connectors` order: what `drivers` indexes and the credentials are read from (`credentialsOf`).
   */
  driversByVendor: Map<string, Driver>;
  /**
   * The makers of the fakes the connectors attach, by vendor id in `connectors` order: each
   * sandbox run makes its own. Resolved with `fakes: "instance"`, each gives its vendor's
   * instance fake (`instanceFakes`).
   */
  fakes: Map<string, () => Fake<any, any>>;
  /**
   * Resolved with `fakes: "instance"` (a demo): each vendor's one fake, by vendor id, made once
   * for this resolution. Each is its vendor's driver (`driversByVendor`), so live runs, sandbox
   * runs and direct calls all call it, and the world's Givens seed it (`applyGivens`).
   */
  instanceFakes?: ReadonlyMap<string, Fake<any, any>>;
  /** The makers of the login halves the connectors attach, by vendor id in `connectors` order: the app makes one per public site that names it. */
  logins: ReadonlyMap<string, NonNullable<ConnectorSetup["login"]>>;
  /** The makers of the model halves the connectors attach, by vendor id in `connectors` order: the app makes each once for its model registry. */
  models: ReadonlyMap<string, NonNullable<ConnectorSetup["model"]>>;
  /** The remote halves the connectors attach, made once for this resolution, by vendor id in `connectors` order: `remoteFor` finds a URL's. */
  remotes: ReadonlyMap<string, RemoteHalf>;
  /**
   * `root`, as a `file:` URL, when `scenarios/` or an app's `apps/<app>/scenarios/` in it is a
   * directory: the feature files under those, each named by its path from the root.
   */
  scenarios?: URL;
  /** The resource types the connectors declare (and `sanoma.wakeup`, beside a host type), by `<vendor>.<type>`: what the drift workflow checks and scenarios seed. */
  types: ReadonlyMap<string, Resource>;
  /** The steps scenarios can use besides the generic ones: each connector's (`withSetup`), once each, then the config's own. */
  steps: readonly Steps[];
  /** The config's collections, by name: their operations are in `ops` and `drivers`, their fake in `fakes`, under `DATA_VENDOR`. */
  collections: ReadonlyMap<string, Collection>;
  /**
   * The pool the collections' driver keeps their records through, when there are any: opened on
   * its first call, and closed by whoever calls the driver (the worker, and the client, which
   * calls it directly, when each stops).
   */
  dataStore?: LazyPool;
  /**
   * By name; each checked against `ops` and `drivers`. The config's, the built-ins `drift`
   * (`DRIFT_WORKFLOW`) and `apply` (`APPLY_WORKFLOW`) when its connectors declare resource types,
   * and `call` (`CALL_WORKFLOW`) when an operation may be called directly (`isDirect`).
   */
  workflows: Map<string, WorkflowDefinition<any, any>>;
  /**
   * Checked before every operation call and run start: the root's `policies/**\/*.cedar`
   * (`policyAt`), `allowAll` without any, and one that refuses everything while they have problems.
   */
  policy: Policy;
  /** The policies `policy` is made from (`loadPolicies`), none without any; undefined while they have problems. */
  policies?: readonly CedarPolicySource[];
  /** What is wrong in the policies, one printable line each (`file:line:col: <policy id>: <message>`). */
  policyProblems: string[];
  /** The config's `ledger`, when it gives one; the worker and the client otherwise make `postgresLedger` on `databaseUrl` (`ownedLedger`). */
  ledger?: LedgerStore;
  /**
   * The config's directory, absolute: its `root`, else its `file`'s directory. Its data files
   * are `resources/` in it. Absent when the config has neither, so it has no data files.
   */
  root?: string;
}

/**
 * The database when neither the config nor `SANOMA_DATABASE_URL` names one: the dev Postgres
 * `pnpm db:up` starts in this checkout. The `sanoma` launcher never falls back to it: with no
 * URL named it starts the company's own Postgres and sets `SANOMA_DATABASE_URL` to it.
 */
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

/** What `resolveConfig` is given besides the config. */
export interface ResolveOptions {
  /**
   * `"instance"`: run the whole instance on the connectors' fakes, as a demo does: each vendor's
   * driver is one fake made for this resolution (`instanceFakes`), which every run and call
   * shares. The collections stay on the config's database. Refused for a vendor whose connector
   * attaches a driver and no fake, which would otherwise run live.
   */
  fakes?: "instance";
}

/**
 * Checks a config and derives what the runtime needs from it: the drivers and fakes from the
 * connectors' setups (`withSetup`), the collections' operations, driver and fake, and from
 * `root`, the app's name (`package.json`), the scenarios (`scenarios/`) and the policy
 * (`policies/`, `policyAt`). Throws what
 * `startWorker` would refuse, with the same message, so `describeConfig`, `SanomaClient.connect`
 * and the app fail the same way the worker does. It opens nothing and reads no file outside
 * `root`. Each entry point resolves once: the worker and the client when they start, the app at
 * `startApp`, the `sanoma` bin when it loads the config.
 */
export function resolveConfig(config: SanomaConfig, options: ResolveOptions = {}): ResolvedConfig {
  if (!Array.isArray(config.connectors)) {
    throw new Error("The config needs `connectors`: the connectors its workflows call, as their packages export them");
  }
  for (const connector of config.connectors as unknown[]) checkConnector(connector);
  if (config.workflows !== undefined && !Array.isArray(config.workflows)) {
    throw new Error("The config's `workflows`, when given, is an array of defineWorkflow definitions");
  }
  // An untyped config naming fake drivers would otherwise run live. Delete once sanoma-ops has migrated.
  if (config.drivers !== undefined || config.fakes !== undefined)
    throw new Error(
      "The config's `drivers` and `fakes` are gone: each connector carries its driver and its fake; leave them out",
    );
  // An untyped config naming its policy would otherwise run allowing everything. Delete once sanoma-ops has migrated.
  if (config.policy !== undefined) {
    throw new Error("The config's `policy` is gone: the policy is policies/*.cedar in the root; leave it out");
  }
  const collections = collectionsOf(config);
  const ledger = ledgerOf(config);
  const root = rootOf(config);
  const appName = appNameAt(root);
  const scenarios = scenariosAt(root);
  // With the built-in `sanoma.wakeup` when they declare a host type.
  const running = withBuiltIns(config.connectors);
  const types = resourceTypesOf(running);
  // Built-in: `sanoma.source.resolve`, which apply and drift call for a host's revision.
  const hosts = [...types.values()].some((type) => type.host);
  // Built-in: the collections' operations, `data.<name>.<op>`, on the config's database.
  const databaseUrl = resolveDatabaseUrl(config);
  const declared = [...collections.values()];
  const dataStore = declared.length ? lazyPool(databaseUrl, "data") : undefined;
  // Built-in, in every config: a change's operations, which the template's policy names (`sanoma.change.merge`).
  const ops = indexConnectors([
    ...running,
    changeOps,
    ...(hosts ? [sourceOps] : []),
    ...(dataStore ? [collectionsConnector(declared)] : []),
  ]);
  checkWakeupOps(types, ops);
  checkDatabaseOps(types, ops);
  const fakes = makersOf(running, "fake");
  const instanceFakes = options.fakes === "instance" ? instanceFakesOf(running, fakes) : undefined;
  const driversByVendor = instanceFakes
    ? new Map([...instanceFakes].map(([vendor, fake]) => [vendor, fake.driver]))
    : new Map([...makersOf(running, "driver")].map(([vendor, make]) => [vendor, make()]));
  const drivers = indexDrivers(
    [
      ...driversByVendor.values(),
      changeDriver(),
      ...(hosts ? [sourceDriver] : []),
      ...(dataStore ? [collectionsDriver(declared, dataStore)] : []),
    ],
    ops,
  );
  if (dataStore) fakes.set(DATA_VENDOR, () => collectionsFake(declared));
  const names = new Map<string, WorkflowDefinition<any, any>>();
  for (const wf of config.workflows ?? []) {
    if (BUILT_IN_WORKFLOWS.has(wf.name)) {
      throw new Error(`A workflow is named "${wf.name}", the name of a built-in workflow; name it otherwise`);
    }
    checkUses(wf, ops, drivers, types);
    checkSchedule(wf);
    const other = names.get(wf.name);
    if (other && other !== wf) {
      throw new Error(
        `Two different workflow definitions are named "${wf.name}"; a name can be registered once per process`,
      );
    }
    names.set(wf.name, wf);
  }
  // Built-in: checking the resources the data files declare against their vendors, and applying them.
  if (types.size) {
    const connectors = connectorsOf(config);
    // The types the data files may declare: the vendors' and the people's, whose resources are left out.
    const declarable = resourceTypesOf(connectors);
    const read = () => readDeclared(root, connectors, declarable, types);
    names.set(
      DRIFT_WORKFLOW,
      driftWorkflow(types, ops, drivers, () => DBOS.runStep(read, { name: "drift:data-files" })),
    );
    names.set(APPLY_WORKFLOW, applyWorkflow(types, ops, drivers, applySteps(appName, root, read)));
  }
  // Built-in: a direct call the policy holds for an approval, made a run, when any operation may be called directly.
  const call = callWorkflow(ops, drivers, types);
  if (call.uses.length) names.set(CALL_WORKFLOW, call);
  const { policy, policies, problems: policyProblems } = policyAt(root, { ops, workflows: names, collections });
  return {
    appName,
    databaseUrl,
    // The built-in's code and operations are part of the app's version, like the config's own.
    version: computeVersion({ appName, workflows: [...names.values()] }),
    queueName: `sanoma:${appName}`,
    ops,
    drivers,
    driversByVendor,
    fakes,
    ...(instanceFakes && { instanceFakes }),
    logins: makersOf(config.connectors, "login"),
    models: makersOf(config.connectors, "model"),
    remotes: new Map([...makersOf(config.connectors, "remote")].map(([vendor, make]) => [vendor, make()])),
    ...(scenarios && { scenarios }),
    types,
    steps: [...new Set([...running.flatMap((c) => setupOf(c).steps ?? []), ...(config.steps ?? [])])],
    collections,
    ...(dataStore && { dataStore }),
    workflows: names,
    policy,
    ...(policies && { policies }),
    policyProblems,
    ...(ledger !== undefined && { ledger }),
    ...(root !== undefined && { root }),
  };
}

/**
 * The config's collections by name, checked: each one `collection()` made, no two with one name,
 * and no connector of their vendor, `DATA_VENDOR`.
 */
function collectionsOf(config: SanomaConfig): Map<string, Collection> {
  const list: unknown = config.collections ?? [];
  if (!Array.isArray(list)) {
    throw new Error("The config's `collections` must be an array of the collections `collection()` declares");
  }
  if (config.connectors.some((c) => c[VENDOR].id === DATA_VENDOR)) {
    throw new Error(
      `A connector in \`connectors\` is of the vendor "${DATA_VENDOR}", which the collections' operations are of; name it otherwise`,
    );
  }
  const collections = new Map<string, Collection>();
  for (const c of list) {
    if (!isCollection(c)) throw new Error("`collections` holds something `collection()` did not make");
    const other = collections.get(c.name);
    if (other && other !== c) throw new Error(`Two collections are named "${c.name}"; name each once`);
    collections.set(c.name, c);
  }
  return collections;
}

/**
 * `sanoma.wakeup`, the runtime's own: the type's operations and `sanoma.wakeup.register` (effect
 * `write`), which the worker registers each deadline through before it stops, with its live
 * driver (`sanomaWakeupDriver`), its fake (`fakeSanomaWakeup`) and its step. `withBuiltIns`
 * merges it into every config with a host type.
 */
export const sanomaWakeup = withSetup(wakeupOps, {
  driver: sanomaWakeupDriver,
  fake: fakeSanomaWakeup,
  steps: wakeupSteps,
});

/**
 * The connectors and, when they declare a host type, the runtime's own wakeup (`sanoma.wakeup`),
 * the fallback for a host with no clock of its own: what a config runs on. The same array when
 * they declare none.
 */
const withBuiltIns = (connectors: Connector<any, any>[]): Connector<any, any>[] =>
  [...resourceTypesOf(connectors).values()].some((type) => type.host) ? [...connectors, sanomaWakeup] : connectors;

/**
 * The config's connectors (with `sanoma.wakeup` when they declare a host type) and the runtime's
 * people types' (`peopleConnector`): what its data files are read against.
 */
export const connectorsOf = (config: Pick<SanomaConfig, "connectors">): Connector<any, any>[] => [
  ...withBuiltIns(config.connectors),
  peopleConnector,
];

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
 * Each vendor's one fake, made now, for `resolveConfig`'s `fakes: "instance"`; `fakes` (the
 * makers) then give these. Refuses a connector that attaches a driver and no fake.
 */
function instanceFakesOf(
  connectors: readonly Connector<any, any>[],
  fakes: Map<string, () => Fake<any, any>>,
): Map<string, Fake<any, any>> {
  const live = [...makersOf(connectors, "driver").keys()].filter((vendor) => !fakes.has(vendor));
  if (live.length) {
    throw new Error(
      `The instance runs on fakes, but the connector of ${live.join(", ")} attaches no fake, so it would run live; attach one (\`withSetup\`) or leave it out`,
    );
  }
  const made = new Map([...fakes].map(([vendor, make]) => [vendor, make()]));
  for (const [vendor, fake] of made) fakes.set(vendor, () => fake);
  return made;
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

/**
 * The root, as a `file:` URL to the directory (with its trailing slash), when `<root>/scenarios/`
 * or an app's `apps/<app>/scenarios/` is a directory: the scenarios are the feature files there,
 * each named by its path from the root (`scenarioFiles`).
 */
function scenariosAt(root: string | undefined): URL | undefined {
  if (root === undefined || !kindDirs(root, SCENARIOS_DIR).some(isDirectory)) return undefined;
  return pathToFileURL(`${root}/`);
}

/**
 * The one wakeup the config's data files declare, or undefined: with none, and with one the reader
 * leaves out for a problem (its declaration's or its host's; several wakeups are each one).
 * Undefined means the instance has no wakeup, so it must not stop. Server-side: it reads the data
 * files and the lockfile, only when the config has a wakeup type (`sanoma.wakeup` beside any host type).
 */
export async function declaredWakeup(config: SanomaConfig): Promise<DeclaredWakeup | undefined> {
  const connectors = connectorsOf(config);
  const types = resourceTypesOf(connectors);
  if (![...types.values()].some((type) => type.wakeup)) return undefined;
  // Loaded when it is needed, not with the worker: the reader parses with oxc-parser.
  const { readDataFiles } = await import("./resources.ts");
  const { resources } = readDataFiles(rootOf(config), connectors, types);
  const typeOf = (r: DeclaredResource) => types.get(`${r.vendor}.${r.type}`)!;
  const declared = resources.find((r) => typeOf(r).wakeup);
  if (!declared) return undefined;
  const type = typeOf(declared);
  const host = resources.find((r) => r.id === declared.refs[type.wakeup!.inputs.host]);
  return {
    id: declared.id,
    type,
    declared,
    ...(declared.binding !== undefined && { binding: declared.binding }),
    ...(host && { host: { id: host.id, type: typeOf(host) } }),
  };
}

/**
 * The data files under `root` and the lockfile beside them, in one read, as a drift or apply run
 * records them: each resource with its binding, without its write-only values (a secret marker
 * names one, and stays), which a run never compares and never records, the bindings, the orphans
 * and the problems.
 */
async function readDeclared(
  root: string | undefined,
  connectors: readonly Connector<any, any>[],
  declarable: ReadonlyMap<string, Resource>,
  types: ReadonlyMap<string, Resource>,
): Promise<Omit<ApplyDeclared, "rebinds">> {
  // Loaded when a run reads the files, not with the worker: the reader parses with oxc-parser.
  const { readDataFiles } = await import("./resources.ts");
  const { resources, bindings, orphans, problems } = readDataFiles(root, connectors, declarable);
  return {
    // Only `types`' resources have a vendor object to check or apply: not the people's (vendorless).
    resources: resources
      .filter((r) => types.has(`${r.vendor}.${r.type}`))
      .map(({ id, vendor, type, name, identity, binding, desired, refs }) => ({
        id,
        vendor,
        type,
        name,
        ...(identity !== undefined && { identity }),
        ...(binding !== undefined && { binding }),
        desired: withoutWriteOnly(types.get(`${vendor}.${type}`)!.fields, desired),
        refs,
      })),
    bindings,
    orphans,
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
 * None may use an operation a built-in workflow alone calls (`reservedFor`): a declared resource's
 * change, which only apply makes, or a change's step, which only the change workflow takes.
 */
function checkUses(
  wf: WorkflowDefinition<any, any>,
  ops: Map<string, Op>,
  impls: Map<string, unknown>,
  types: ReadonlyMap<string, Resource>,
) {
  const problems: string[] = [];
  for (const op of (wf.uses as readonly Use[]).filter(isOp)) {
    const known = ops.get(op.id);
    const reserved = known && reservedFor(known, types);
    if (!known) problems.push(`${op.id} is not declared by any connector in \`connectors\``);
    else if (reserved) {
      problems.push(`${op.id} ${reserved.does}, which only ${reserved.workflow} does: ${reserved.instead} instead`);
    } else if (known !== op && (known.effect !== op.effect || known.idempotent !== op.idempotent)) {
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
