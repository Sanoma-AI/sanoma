import { setTimeout as delay } from "node:timers/promises";
import {
  RUNTIME_PORT,
  type CallContext,
  DriverError,
  errorMessage,
  HOST_URL,
  isSecret,
  type PlanAction,
  resolveSecrets,
  retryableStatus,
  WAKE_PATH,
  type WakeupRegistration,
} from "@sanoma-ai/workflows";
import { domainsOf, domainsText, hostnameUrl, siteAtHostname } from "@sanoma-ai/workflows/shared";
import { instanceUrl, mintInstanceToken, WAKEUP_TOKEN } from "@sanoma-ai/workflows/wakeup-service";
import { alarm, container, type host } from "./connector.ts";
import { refused } from "./errors.ts";
import { accountPinned } from "./registry.ts";
import {
  APP,
  appBundle,
  appModules,
  ASSETS_CONFIG,
  MAIN_MODULE,
  OBJECT_CLASS,
  uploadAssets,
  waitFor,
  type WorkerModule,
  workerModules,
} from "./deploy.ts";
import {
  DEPLOYMENT_HEADER,
  deploymentOf,
  HEALTH_PATH,
  IMAGE,
  NAMESPACE,
  VERSION_METADATA,
} from "../worker/instance.js";

// Cloudflare as the operations use it (`CloudflareApi`), and the host's and the alarm's
// operations over it: the driver's calls its API with the SDK and the Worker over HTTP, the
// fake's answers from its state and its Worker in this process. Both go through `containerOps`
// and `alarmOps` (and `recordsOps`, in `records.ts`), so they upload, plan and refuse alike.

/** The Workers runtime of a create's uploads before its first bundle; the bundle's own after. */
const COMPATIBILITY_DATE = "2026-10-01";
/** The migration that makes the Worker's object class, on its first upload only. */
export const MIGRATION = { new_tag: "v1", new_sqlite_classes: [OBJECT_CLASS] };
/** How long the account may take to prepare an image to run, as Wrangler waits for it. */
const PREPARE_TIMEOUT_MS = 15 * 60_000;

/** The plain-text bindings that say what the Worker runs: a read reads them back. */
const TEXT = {
  source: "SANOMA_SOURCE",
  ref: "SANOMA_REF",
  revision: "SANOMA_REVISION",
  configurationRevision: "SANOMA_CONFIG_REVISION",
  image: "SANOMA_IMAGE",
  port: "PORT",
  domains: "SANOMA_DOMAINS",
  /** The app's own custom domain, when declared: the state's `url` is then `https://<hostname>`. */
  hostname: "SANOMA_HOSTNAME",
  url: HOST_URL,
} as const;
/** The app's database, a Hyperdrive config over the host's `SANOMA_DATABASE_URL` (`AppBundleEnv.DATABASE`). */
const DATABASE = "DATABASE";
/** The app bundle's static assets (`AppBundleEnv.ASSETS`). */
const ASSETS = "ASSETS";
/** Names a secret may not take: the Worker's own bindings. */
const RESERVED = new Set<string>([NAMESPACE, DATABASE, ASSETS, VERSION_METADATA, ...Object.values(TEXT)]);

/** A binding as the upload sends it. */
export type Binding =
  | { type: "durable_object_namespace"; name: string; class_name: string }
  | { type: "plain_text" | "secret_text"; name: string; text: string }
  | { type: "hyperdrive"; name: string; id: string }
  | { type: "assets"; name: string }
  | { type: "version_metadata"; name: string };

/** A binding as a read shows it: a secret's name, never its text. */
export interface ReadBinding {
  type: string;
  name: string;
  text?: string;
  /** A Durable Object namespace's id, which the container application is made for. */
  namespace_id?: string;
  /** A Hyperdrive config's id. */
  id?: string;
}

/** A Worker's settings, as the fields read here (`GET …/scripts/{name}/settings`): its latest version's. */
export interface WorkerSettings {
  bindings: ReadBinding[];
  compatibility_date?: string;
  compatibility_flags?: string[];
  /** The version's tag, which a deploy sets to the revision of the app the version serves (`Upload.annotations`). */
  annotations?: { "workers/tag"?: string };
}

/** Whether a Worker's bindings are Sanoma's: its own object's namespace among them. */
const isOurs = (bindings: ReadBinding[]) =>
  bindings.some((b) => b.type === "durable_object_namespace" && b.name === NAMESPACE);
/** Whether a Worker serves an app: only an upload of one binds its database. */
const servesApp = (bindings: ReadBinding[]) => bindings.some((b) => b.type === "hyperdrive" && b.name === DATABASE);

/** The upload's metadata and modules (`PUT …/workers/scripts/{name}`). */
export interface Upload {
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  bindings: Binding[];
  /**
   * The object classes that run a container (the namespace is container-enabled), each with its
   * application's name and the images its object may start, by name, pinned by digest.
   */
  containers: { name: string; class_name: string; images: Record<string, string> }[];
  /** On the first upload only. */
  migrations?: typeof MIGRATION;
  /** The Worker's own logs (what its object saw of a start), kept by Cloudflare for seven days. */
  observability: { enabled: boolean };
  /**
   * The assets an upload session put in (its completion `jwt`), or with `keep_assets` the ones the
   * Worker's version before had, and how the Worker serves them (`ASSETS_CONFIG`).
   */
  assets?: { jwt?: string; config: Record<string, unknown> };
  keep_assets?: boolean;
  /** The version's tag: the revision of the app it serves, which a plan compares with `SANOMA_REVISION`. */
  annotations?: { "workers/tag": string };
  modules: WorkerModule[];
}

/** A container application, as the fields read here. */
export interface Application {
  id: string;
}

/** An image's preparation (`POST …/containers/image-preparations`): `pending` until it is `ready`, or an `error`. */
export interface Preparation {
  status: "pending" | "ready" | "error";
  /** Why it is still pending, or failed. */
  reason?: string;
}

/** The database a Hyperdrive config reaches, as its `origin` takes it: from the host's `SANOMA_DATABASE_URL`. */
export interface HyperdriveOrigin {
  scheme: "postgres" | "postgresql";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/** A custom domain attached to a Worker, as the fields read here. */
export interface AttachedDomain {
  id: string;
  hostname: string;
}

/** A DNS record as a zone holds it (`GET /zones/{id}/dns_records`), as the fields read here. */
export interface ZoneRecord {
  id: string;
  type: string;
  /** The full name, as Cloudflare gives it. */
  name: string;
  /** As Cloudflare shows it: a TXT record's text may be quoted. */
  content: string;
  priority?: number;
  /** In seconds; 1 is automatic. */
  ttl: number;
  comment?: string | null;
  /** Whether its traffic goes through Cloudflare; a set's never does. */
  proxied?: boolean;
}

/** A record as a batch writes it: never proxied, its comment the set's mark. */
export interface RecordWrite {
  type: string;
  name: string;
  ttl: number;
  proxied: false;
  comment: string;
  /** Everything but a CAA record's. */
  content?: string;
  /** An MX record's. */
  priority?: number;
  /** A CAA record's, which Cloudflare takes as fields, not as content. */
  data?: { flags: number; tag: string; value: string };
}

/** One batch of DNS changes (`POST /zones/{id}/dns_records/batch`), which Cloudflare runs as one transaction: deletes, patches, then posts. */
export interface DnsBatch {
  posts: RecordWrite[];
  patches: (RecordWrite & { id: string })[];
  deletes: { id: string }[];
}

/** Cloudflare, as the operations use it. Each call fails with a `DriverError`, except `send`. */
export interface CloudflareApi {
  /** The Worker's URL: `https://<script>.<account subdomain>.workers.dev`. */
  workerUrl(script: string): Promise<string>;
  /** The Worker's settings (`GET …/scripts/{name}/settings`); undefined when there is no such Worker. */
  settings(script: string): Promise<WorkerSettings | undefined>;
  /** The modules of the Worker's latest version (`GET …/scripts/{name}/content/v2`), as an upload names them. */
  content(script: string): Promise<WorkerModule[]>;
  /** Uploads the Worker and deploys it (`PUT …/scripts/{name}`). */
  upload(script: string, upload: Upload): Promise<void>;
  /** Turns its workers.dev URL on (`POST …/scripts/{name}/subdomain { enabled }`). */
  enableSubdomain(script: string): Promise<void>;
  /** The account's id, which its registry's references name (`accountImage`). */
  account: string;
  /**
   * Copies an image of another registry into the account's, as `accountImage(image, account)`,
   * and returns the copy pinned by digest: what the object starts (one in the account's registry
   * by a tag is only pinned).
   */
  copyImage(image: string): Promise<string>;
  /** Asks the account to prepare a pinned image to run, once more (idempotent): where it is. */
  prepareImage(image: string): Promise<Preparation>;
  /** The Hyperdrive config of that name, if any (`GET …/hyperdrive/configs`). */
  hyperdrive(name: string): Promise<{ id: string } | undefined>;
  /** Makes a Hyperdrive config over `origin`, its query caching off (`POST …/hyperdrive/configs`). */
  createHyperdrive(name: string, origin: HyperdriveOrigin): Promise<{ id: string }>;
  /** Sets a config's origin again, its caching off (`PUT …/hyperdrive/configs/{id}`): a password is never read back to compare. */
  updateHyperdrive(id: string, name: string, origin: HyperdriveOrigin): Promise<void>;
  /** Deletes a config; nothing when there is none. */
  deleteHyperdrive(id: string): Promise<void>;
  /** Deletes the Worker, its object's storage with it; nothing when there is none. */
  deleteScript(script: string): Promise<void>;
  /** The container application of that name, if any (`GET …/containers/applications?name=`). */
  application(name: string): Promise<Application | undefined>;
  /**
   * Makes the application behind the Worker's object, of the `durable_object` scheduling policy:
   * the object starts its container, at the image the upload names, so it holds no image itself.
   */
  createApplication(name: string, namespaceId: string): Promise<Application>;
  /** Deletes the application; nothing when there is none. */
  deleteApplication(id: string): Promise<void>;
  /** The id of the account's zone of that name (`GET /zones?name=&account.id=`); undefined when it holds none. */
  zone(name: string): Promise<string | undefined>;
  /** The custom domains attached to the Worker (`GET …/workers/domains?service=`). */
  domains(script: string): Promise<AttachedDomain[]>;
  /** Attaches `hostname`, of the zone `zoneId`, to the Worker as a custom domain (`PUT …/workers/domains`). */
  attachDomain(script: string, hostname: string, zoneId: string): Promise<void>;
  /** Detaches a custom domain (`DELETE …/workers/domains/{id}`); nothing when it is gone. */
  detachDomain(id: string): Promise<void>;
  /** The zone's records that carry the comment `comment` exactly (`GET /zones/{id}/dns_records?comment.exact=`). */
  dnsRecords(zoneId: string, comment: string): Promise<ZoneRecord[]>;
  /** The zone's records at the full name `name`, whoever's (`GET /zones/{id}/dns_records?name.exact=`). */
  dnsRecordsAt(zoneId: string, name: string): Promise<ZoneRecord[]>;
  /** Writes the batch, all of it or none (`POST /zones/{id}/dns_records/batch`): the records patched and posted, as the zone now holds them. */
  writeDns(zoneId: string, batch: DnsBatch): Promise<{ patches: ZoneRecord[]; posts: ZoneRecord[] }>;
  /**
   * Opens an upload session for the assets of the Worker's next upload
   * (`POST …/scripts/{name}/assets-upload-session`): the buckets of hashes Cloudflare lacks, each
   * one request of `uploadAssets`, and the session's `jwt` (with no buckets, what the upload redeems).
   */
  assetsSession(
    script: string,
    manifest: Record<string, { hash: string; size: number }>,
  ): Promise<{ jwt: string; buckets: string[][] }>;
  /** Uploads one bucket with the session's `jwt` (`POST …/workers/assets/upload?base64=true`): the completion jwt once the last is in. */
  uploadAssets(jwt: string, files: AssetFile[]): Promise<string | undefined>;
  /** A request to a Worker: its answer, or a throw when there is none. */
  send(url: string, init: RequestInit): Promise<Response>;
}

/** One asset as a bucket uploads it: its hash, its content in base64, and the type it is served with. */
export interface AssetFile {
  hash: string;
  base64: string;
  contentType: string;
}

/** The company's Worker, named after it. */
export const scriptOf = (name: string) => `sanoma-${name}`;

/** The zone a hostname is looked up in: its last two labels (`www.acme.example` → `acme.example`). */
export const apexOf = (hostname: string) => hostname.split(".").slice(-2).join(".");

/** The Worker's plain-text bindings, by name. */
const textOf = (bindings: ReadBinding[] | undefined) =>
  new Map((bindings ?? []).filter((b) => b.type === "plain_text").map((b) => [b.name, b.text ?? ""]));

/**
 * The hostnames the Worker's bindings say it was declared to serve (`SANOMA_DOMAINS` and
 * `SANOMA_HOSTNAME`): the custom domains that are Sanoma's to detach. One attached by hand and
 * never declared is left alone.
 */
const declaredBefore = (bindings: ReadBinding[] | undefined) => {
  const text = textOf(bindings);
  const domains = text.get(TEXT.domains);
  const hostname = text.get(TEXT.hostname);
  return new Set([...(domains ? Object.values(domainsOf(domains)) : []), ...(hostname ? [hostname] : [])]);
};

/** Where the app answers: its declared hostname, else the Worker's workers.dev URL. */
const servedAt = (hostname: string | null | undefined, workerUrl: string) =>
  hostname ? hostnameUrl(hostname) : workerUrl;

/**
 * Refuses a hostname that is also a site's domain, before any request: the app and the site would
 * share it. `describeConfig` reports it at a data file's declaration; this guards a workflow's own
 * call, which no data file declares.
 */
const checkHostname = (name: unknown, hostname: unknown, domains: unknown) => {
  if (typeof hostname !== "string") return;
  const site = siteAtHostname(hostname, (domains ?? {}) as Record<string, unknown>);
  if (site) {
    throw refused(
      `container ${String(name)}: hostname ${hostname} is also the domain of the site ${site}: the app and a site need a hostname each`,
      "invalid",
    );
  }
};

type ContainerState = {
  id: string | null;
  name: string;
  image: string;
  source: string;
  ref: string;
  revision: string | null;
  configurationRevision?: string;
  port: number;
  domains?: Record<string, string>;
  hostname?: string;
  url: string;
  worker_url: string;
  healthy: boolean;
};

/** What a plan of a change finds, and the state it planned from. */
export interface Planned {
  action: PlanAction;
  planned?: Record<string, unknown>;
  unknown: string[];
  replace: string[];
}

export const NONE = { unknown: [], replace: [] };

/**
 * Refuses an update (`what`) whose plan, made again, is not the one approved (`expect`: its
 * action and replace), or is not an update: `plan_changed`.
 */
export function replanned(
  what: string,
  fresh: Pick<Planned, "action" | "replace">,
  expect?: { action: PlanAction; replace: string[] },
) {
  if (expect && (expect.action !== fresh.action || expect.replace.join() !== fresh.replace.join())) {
    throw refused(`${what}: the plan changed (${expect.action}, now ${fresh.action})`, "plan_changed");
  }
  if (fresh.action !== "update" && fresh.action !== "none") {
    throw refused(`${what}: the plan is a ${fresh.action}, not an update`, "plan_changed");
  }
}
const sorted = (names: Iterable<string>) => [...names].toSorted().join(",");

/** The declared fields a change of which is an update: everything the Worker runs, and the image. */
const COMPARED = [
  "image",
  "source",
  "ref",
  "revision",
  "configurationRevision",
  "port",
  "domains",
  "hostname",
] as const;
/** The compared fields a declaration may leave out: leaving one out is a change when the Worker has it. */
const OPTIONAL = new Set<string>(["configurationRevision", "domains", "hostname"]);
const same = (field: (typeof COMPARED)[number], a: unknown, b: unknown) =>
  field === "domains"
    ? domainsText((a ?? {}) as Record<string, string>) === domainsText((b ?? {}) as Record<string, string>)
    : (a ?? null) === (b ?? null);

/**
 * `{ revision }` and the deployment of the version that answered (`DEPLOYMENT_HEADER`, none from
 * a version before it was marked) when the Worker's object answers its health, else why not. A read asks without
 * `start`: a stopped host is healthy, and stays stopped. With `start` and the instance token, only
 * once its container runs at what the Worker names and answered, which the ask starts (202
 * meanwhile). A container that ended is `exit`: asking again would only start it again, so a deploy
 * stops asking.
 */
const health = async (
  cf: CloudflareApi,
  url: string,
  token?: string,
): Promise<
  { revision: string; configurationRevision?: string; deployment: string | null } | { error: string; exit: boolean }
> => {
  let res: Response;
  try {
    res = await cf.send(`${url}${HEALTH_PATH}${token === undefined ? "" : "?start=1"}`, {
      method: "GET",
      ...(token !== undefined && { headers: { authorization: `Bearer ${token}` } }),
    });
  } catch (error) {
    return { error: errorMessage(error), exit: false };
  }
  const body = (await res.json().catch(() => undefined)) as
    | { revision?: unknown; configurationRevision?: unknown; error?: unknown; exit?: unknown; last?: unknown }
    | undefined;
  if (res.status === 200 && typeof body?.revision === "string")
    return {
      revision: body.revision,
      ...(typeof body.configurationRevision === "string" && { configurationRevision: body.configurationRevision }),
      deployment: res.headers.get(DEPLOYMENT_HEADER),
    };
  const error =
    typeof body?.error === "string"
      ? body.error
      : res.status === 202
        ? `its container is starting${typeof body?.last === "string" ? ` (${body.last})` : ""}`
        : `${HEALTH_PATH} answered ${res.status}`;
  return { error, exit: typeof body?.exit === "string" };
};

/** Whether the full name `name` is in the zone `zone`: the zone's apex or a name under it. */
export const inZone = (name: string, zone: string) => name === zone || name.endsWith(`.${zone}`);

/**
 * Each hostname's zone id, by hostname, looked up in the account once per apex; a refusal for a
 * hostname whose zone the account does not hold.
 */
const zonesOf = async (cf: CloudflareApi, name: string, hostnames: string[]) => {
  const ids = new Map<string, string>();
  for (const hostname of hostnames) {
    const apex = apexOf(hostname);
    if (ids.has(apex)) continue;
    const id = await cf.zone(apex);
    if (id === undefined) {
      throw refused(
        `container ${name}: the account holds no zone ${apex} for the domain ${hostname}, or the API token cannot read it: add the zone to the account or Zone Read to the token, or declare another domain`,
        "no_zone",
      );
    }
    ids.set(apex, id);
  }
  return new Map(hostnames.map((hostname) => [hostname, ids.get(apexOf(hostname))!]));
};

/** The Hyperdrive config's origin from the host's database URL; a refusal that never shows the URL, which holds the password. */
export function originOf(name: string, databaseUrl: string): HyperdriveOrigin {
  let url: URL | undefined;
  try {
    url = new URL(databaseUrl);
  } catch {
    // Said below, without the URL.
  }
  const scheme = url?.protocol.slice(0, -1);
  let decoded: { database: string; user: string; password: string } | undefined;
  try {
    if (url) {
      decoded = {
        database: decodeURIComponent(url.pathname.slice(1)),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      };
    }
  } catch {
    // A malformed escape: said below, without the URL.
  }
  if (
    !url ||
    !decoded ||
    (scheme !== "postgres" && scheme !== "postgresql") ||
    !url.hostname ||
    !decoded.user ||
    !decoded.database
  ) {
    throw refused(
      `container ${name}: SANOMA_DATABASE_URL is not a postgres:// URL with a user, a host and a database, which Hyperdrive needs`,
      "invalid",
    );
  }
  return { scheme, host: url.hostname, port: Number(url.port || 5432), ...decoded };
}

export interface ContainerOptions {
  /** How long a deploy waits for each of its waits: an upload live, the app bundle at the new revision, the container restarted at it. */
  startTimeoutMs: number;
  /** How long between two tries. */
  pollMs: number;
}

/**
 * `cloudflare.host`'s operations over `api()`, made on each call (`cloudflare.container`'s are
 * the same, `type` the one whose fields a call is parsed by). A host is given by apply what its
 * data file leaves out; its port is the image's. A create and an update are one upsert, a deploy
 * at revision R in three steps, each with its own wait, so a visitor is answered throughout:
 *
 * 1. Build first: the app bundle at R (`appBundle`), asked of the Worker's object, which starts its
 *    container when it is stopped and passes the ask on to the worker running there. The deployed
 *    Worker's container, still at R-1, builds it when it runs the declared image and can (not
 *    stale); else R's own does: the Worker at R is uploaded first, serving visitors the app
 *    deployed meanwhile (`serving`), and asked once that version is live.
 * 2. One upload: the Worker at R, the bundle's modules under `app/`, its assets through an upload
 *    session, every binding (the text that says what it runs, the secrets, the database as a
 *    Hyperdrive config, the assets, the object's namespace and its container's image), and its
 *    version tagged with R, which a plan compares with the revision. The visitors' next request
 *    runs it.
 * 3. Restart last: once the upload is live, the object, asked for its health with `start`, drains
 *    a worker at another revision or image and starts the container at R (`instance.js`), and the
 *    wait ends once it answers there. An update whose plan is none (the upload made, the restart
 *    not seen: a deploy that died in its wait, or the restart of the worker that ran it) makes this
 *    step alone.
 *
 * After each upload, before the object is asked, `live` waits until that version answers: an
 * upload reaches every location over a while. Before them, as Wrangler orders it: the image copied
 * and pinned, then prepared, the Hyperdrive config made or set again, and on a create the Worker
 * uploaded without an app (`no-app.js`, the migration on its first upload), its workers.dev URL
 * turned on and its application made, then uploaded once more so its object learns the
 * application. A domain declared before and no longer is detached before the first upload of R's
 * bindings, and a missing one attached after the upload with the app. The instance token
 * (`SANOMA_WAKEUP_TOKEN`), which the bundle and the restart are asked with, is the declared one,
 * else the stored one, minted when none is, and always bound.
 */
export function containerOps(
  api: () => CloudflareApi,
  { startTimeoutMs, pollMs }: ContainerOptions,
  type: typeof container | typeof host = container,
) {
  /** The Worker `name` runs, from its bindings and its application; `checkHealth` asks it too. None for a Worker that is not Sanoma's. */
  const inspect = async (name: string, checkHealth: boolean) => {
    const cf = api();
    const script = scriptOf(name);
    const settings = await cf.settings(script);
    if (!settings || !isOurs(settings.bindings)) return undefined;
    const { bindings } = settings;
    const app = await cf.application(script);
    const url = await cf.workerUrl(script);
    const text = textOf(bindings);
    const served = text.get(TEXT.domains);
    const declaredHostname = text.get(TEXT.hostname) || undefined;
    // The domains and the hostname it serves that are attached: one whose attach failed, or
    // detached by hand, is drift, so the next apply attaches it again.
    const attached = new Set(served || declaredHostname ? (await cf.domains(script)).map((d) => d.hostname) : []);
    const domains = served
      ? Object.fromEntries(Object.entries(domainsOf(served)).filter(([, hostname]) => attached.has(hostname)))
      : undefined;
    const hostname = declaredHostname && attached.has(declaredHostname) ? declaredHostname : undefined;
    const state: ContainerState = {
      id: app?.id ?? null,
      name,
      // The declared image is the Worker's binding; the object starts its copy (`accountImage`).
      image: text.get(TEXT.image) ?? "",
      source: text.get(TEXT.source) ?? "",
      ref: text.get(TEXT.ref) ?? "",
      revision: text.get(TEXT.revision) ?? null,
      ...(text.has(TEXT.configurationRevision) && { configurationRevision: text.get(TEXT.configurationRevision)! }),
      port: Number(text.get(TEXT.port) ?? 0),
      ...(domains && Object.keys(domains).length > 0 && { domains }),
      ...(hostname && { hostname }),
      // Where the app answers now: at its hostname once attached; its health is asked on workers.dev.
      url: servedAt(hostname, url),
      worker_url: url,
      healthy: checkHealth && app !== undefined && "revision" in (await health(cf, url)),
    };
    const secrets = bindings.filter((b) => b.type === "secret_text").map((b) => b.name);
    // The app at the revision its bindings name: a version without an app has no tag, and one
    // that kept the app deployed before while R's container built R's carries that app's.
    return { state, secrets, serves: settings.annotations?.["workers/tag"] === state.revision };
  };

  const read = async ({ id }: { id: string }) => {
    const found = await inspect(id, true);
    return found ? { id, gone: false, state: found.state } : { id, gone: true };
  };

  const plan = async ({ id, desired }: { id?: string; desired?: Record<string, unknown> }): Promise<Planned> => {
    if (desired) checkHostname(desired.name, desired.hostname, desired.domains);
    const found = id === undefined ? undefined : await inspect(id, false);
    if (!desired) return { action: found ? "delete" : "none", ...NONE };
    const { secrets, ...declared } = desired;
    const unknown = [...type.fields.vendorOwned];
    // A create plans without the account: it needs no credentials yet.
    if (!found) return { action: "create", planned: declared, unknown, replace: [] };
    const planned: Record<string, unknown> = declared;
    const { state } = found;
    if (planned.name !== state.name) return { action: "replace", planned, unknown, replace: ["name"] };
    const changed =
      // `domains` and `hostname` left out are compared too: removing one is a change.
      COMPARED.some(
        (field) => (field in planned || OPTIONAL.has(field)) && !same(field, planned[field], state[field]),
      ) ||
      // The instance token is bound whether declared or not.
      sorted(new Set([...Object.keys(secrets ?? {}), WAKEUP_TOKEN])) !== sorted(found.secrets) ||
      // A deploy that ended before its upload of the app.
      !found.serves;
    if (!changed) return { action: "none", planned: state, ...NONE };
    // What the Worker will serve: the declared domains and hostname, none of the found ones left
    // out; the app at the declared hostname, or on workers.dev without one.
    const { domains: _domains, hostname: _hostname, ...was } = state;
    const url = servedAt(planned.hostname as string | null | undefined, state.worker_url);
    return {
      action: "update",
      planned: {
        ...was,
        ...planned,
        ...(state.configurationRevision !== undefined &&
          planned.configurationRevision == null && { configurationRevision: null }),
        url,
      },
      ...NONE,
    };
  };

  /** `desired` parsed, its secrets resolved, and the instance token: the declared one, else the stored one, minted when none is. */
  const resolved = async (desired: Record<string, unknown>, store: CallContext["secrets"]) => {
    const declared = type.schema.parse(await resolveSecrets(desired, store));
    const token = declared.secrets?.[WAKEUP_TOKEN] ?? (await store.ensure(WAKEUP_TOKEN, mintInstanceToken));
    return { declared, token };
  };

  /**
   * Waits until the Worker version uploaded answers, its `deployment` on the object's health:
   * an upload takes a while to reach every location, and until then the version before answers,
   * or none (a new Worker's workers.dev URL). Asks without `start`, so an earlier version starts
   * nothing.
   */
  const live = (cf: CloudflareApi, { script, url }: { script: string; url: string }, deployment: string) =>
    waitFor(`${script}: the upload is not live yet`, { startTimeoutMs, pollMs }, async () => {
      const seen = await health(cf, url);
      if ("deployment" in seen && seen.deployment === deployment) return { value: undefined };
      return { last: "error" in seen ? seen.error : `an earlier version answers (${seen.deployment ?? "unmarked"})` };
    });

  /**
   * Step 3: has the object restart the container at `revision` (its health with `start`, the worker
   * at another drained first) and waits until it answers there. Asking again is harmless: a
   * container that runs at it is kept.
   */
  const restarted = async (
    cf: CloudflareApi,
    { script, url, token }: { script: string; url: string; token: string },
    revision: string,
    configurationRevision?: string | null,
  ) => {
    // Retryable once its time is up: the upload is made, so the next apply plans none, and waits for this step alone.
    await waitFor(`${script}: still starting at ${revision}`, { startTimeoutMs, pollMs }, async () => {
      const seen = await health(cf, url, token);
      if (
        "revision" in seen &&
        seen.revision === revision &&
        (seen.configurationRevision ?? "") === (configurationRevision ?? "")
      )
        return { value: undefined };
      // Not a wait: the container started and ended, and asking again would only start it again.
      if ("exit" in seen && seen.exit) throw refused(`${script} did not start at ${revision}: ${seen.error}`);
      return {
        last:
          "revision" in seen
            ? `it runs ${seen.revision} with configuration ${seen.configurationRevision ?? "unset"}`
            : seen.error,
      };
    });
  };

  /** Waits until the account prepared `image` to run, as Wrangler does before an upload. */
  const prepared = async (cf: CloudflareApi, image: string) => {
    const until = Date.now() + PREPARE_TIMEOUT_MS;
    for (;;) {
      let status: Preparation["status"] | undefined;
      let reason: string | undefined;
      try {
        ({ status, reason } = await cf.prepareImage(image));
      } catch (error) {
        // One failed look (a timeout, a 5xx) is not the preparation failing: the wait asks again.
        if (!(error instanceof DriverError && error.retryable)) throw error;
      }
      if (status === "ready") return;
      if (status === "error") {
        throw refused(`preparing ${image}: ${reason ?? "it failed"}`);
      }
      if (Date.now() >= until) {
        throw new DriverError(
          `cloudflare: preparing ${image}: not ready in ${PREPARE_TIMEOUT_MS / 60_000} min${reason ? ` (${reason})` : ""}`,
          { retryable: true },
        );
      }
      await delay(pollMs);
    }
  };

  /** Makes the Worker and its application match `desired` at its revision, in the three steps of `containerOps`: a create and an update alike. */
  const put = async (desired: Record<string, unknown>, { secrets: store }: CallContext) => {
    const { declared, token } = await resolved(desired, store);
    const { name, image, source, ref, revision, configurationRevision, domains } = declared;
    const port = declared.port ?? RUNTIME_PORT;
    const hostname = declared.hostname ?? undefined;
    checkHostname(name, hostname, domains);
    const secrets: Record<string, string> = { ...declared.secrets, [WAKEUP_TOKEN]: token };
    if (!name || !image || !source || !ref) {
      const missing = !name ? "name" : !image ? "image" : !source ? "source" : "ref";
      throw refused(`container ${name ?? ""}: no ${missing}: apply gives a host one`);
    }
    if (!revision) {
      throw refused(
        `container ${name}: no revision: apply sets it from ${ref} once its source exists (apply again after a repository it creates)`,
      );
    }
    const taken = Object.keys(secrets).filter((key) => RESERVED.has(key));
    if (taken.length)
      throw refused(`container ${name}: ${taken.join(", ")} is the Worker's own; name the secret otherwise`);
    if (!secrets.SANOMA_DATABASE_URL) {
      throw refused(
        `container ${name}: no SANOMA_DATABASE_URL among its secrets: the app on the Worker reaches the database through Hyperdrive over it`,
      );
    }
    const origin = originOf(name, secrets.SANOMA_DATABASE_URL);
    const cf = api();
    const script = scriptOf(name);
    const url = await cf.workerUrl(script);
    const current = await cf.settings(script);
    if (current && !isOurs(current.bindings)) {
      throw refused(
        `a Worker named ${script} that is not Sanoma's exists: delete it, or name the host otherwise`,
        "exists",
      );
    }
    // Copied and prepared before anything changes, so a copy or a preparation that fails leaves
    // the Worker as it was. Each apply asks again, which costs a manifest's HEAD once the copy is
    // there, and puts back one gone; the object starts only a pinned image of the account's.
    // The custom domains are read first too: the ones an update's Worker has, and each declared
    // one missing (a site's domain or the app's hostname), with its zone, so a domain whose zone
    // the account lacks is refused here.
    const hostnames = new Set([...Object.values(domains ?? {}), ...(hostname ? [hostname] : [])]);
    const before = declaredBefore(current?.bindings);
    const attached = current && (hostnames.size > 0 || before.size > 0) ? await cf.domains(script) : [];
    const held = new Set(attached.map((d) => d.hostname));
    const missing = await zonesOf(
      cf,
      name,
      [...hostnames].filter((h) => !held.has(h)),
    );
    const runs = accountPinned(image, cf.account) ? image : await cf.copyImage(image);
    await prepared(cf, runs);
    // The Hyperdrive config the Worker binds as its database, named after it: made, or set to the URL again.
    const config = await cf.hyperdrive(script);
    if (config) await cf.updateHyperdrive(config.id, script, origin);
    const databaseId = config?.id ?? (await cf.createHyperdrive(script, origin)).id;
    const served = domains ? domainsText(domains) : undefined;
    const text = {
      [TEXT.source]: source,
      [TEXT.ref]: ref,
      [TEXT.revision]: revision,
      ...(configurationRevision && { [TEXT.configurationRevision]: configurationRevision }),
      [TEXT.image]: image,
      [TEXT.port]: String(port),
      // Where the wakeup reaches the Worker: its workers.dev URL, whatever hostname it serves.
      [TEXT.url]: url,
      ...(served && { [TEXT.domains]: served }),
      ...(hostname && { [TEXT.hostname]: hostname }),
    };
    const bindings: Binding[] = [
      { type: "durable_object_namespace", name: NAMESPACE, class_name: OBJECT_CLASS },
      // Its tag, which the object's deployment names.
      { type: "version_metadata", name: VERSION_METADATA },
      ...Object.entries(text).map(([key, value]) => ({ type: "plain_text" as const, name: key, text: value })),
      ...Object.entries(secrets).map(([key, value]) => ({ type: "secret_text" as const, name: key, text: value })),
    ];
    const { entry, noApp } = await workerModules();
    const worker = {
      main_module: MAIN_MODULE,
      containers: [{ name: script, class_name: OBJECT_CLASS, images: { [IMAGE]: runs } }],
      observability: { enabled: true },
    };
    /** R's bindings with its database, and the assets binding when the version has assets. */
    const withApp = (assets: unknown) => [
      ...bindings,
      { type: "hyperdrive" as const, name: DATABASE, id: databaseId },
      ...(assets ? [{ type: "assets" as const, name: ASSETS }] : []),
    ];
    /** The Worker without an app: what a Worker that never served one runs until its first bundle. */
    const bare = {
      ...worker,
      bindings,
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: [],
      modules: [...entry, noApp],
    };
    /**
     * The Worker at R, its object starting R's container, that serves visitors what they are served
     * now: the app deployed (its modules, runtime, assets and tag, fetched back), or no app when the
     * Worker never served one.
     */
    const serving = async (): Promise<Upload> => {
      if (!current || !servesApp(current.bindings)) return bare;
      const app = (await cf.content(script)).filter((m) => m.name.startsWith(APP));
      const assets = current.bindings.some((b) => b.type === "assets" && b.name === ASSETS);
      const tag = current.annotations?.["workers/tag"];
      return {
        ...worker,
        bindings: withApp(assets),
        compatibility_date: current.compatibility_date ?? COMPATIBILITY_DATE,
        compatibility_flags: current.compatibility_flags ?? [],
        ...(assets && { keep_assets: true, assets: { config: ASSETS_CONFIG } }),
        ...(tag && { annotations: { "workers/tag": tag } }),
        modules: [...entry, ...app],
      };
    };
    // A domain declared before and no longer is detached while the bindings still record it, before
    // the first upload of R's, and a missing one attached once the upload with the app records it:
    // whatever fails in between, none is left attached and unrecorded, and the next apply attaches
    // what is still missing. Once: the list is emptied.
    const gone = attached.filter((d) => before.has(d.hostname) && !hostnames.has(d.hostname));
    const detach = async () => {
      for (const domain of gone.splice(0)) await cf.detachDomain(domain.id);
    };
    /** The Worker at R this put uploaded before its bundle, whose object starts R's container. */
    let first: Upload | undefined;
    const uploadServing = async () => {
      await detach();
      first = await serving();
      await cf.upload(script, first);
      return first;
    };
    if (!current) {
      first = bare;
      await cf.upload(script, { ...bare, migrations: MIGRATION });
    }
    await cf.enableSubdomain(script);
    let app = await cf.application(script);
    if (!app) {
      // The application is made for the object's namespace, which the first upload made.
      const namespace = (await cf.settings(script))?.bindings.find((b) => b.name === NAMESPACE)?.namespace_id;
      if (!namespace) throw refused(`${script}: Cloudflare names no namespace for its ${NAMESPACE} binding`);
      app = await cf.createApplication(script, namespace);
      // The object learns which application backs its namespace from a deployment made after
      // the application exists: without this upload every start answers "There is no container
      // application assigned to this Durable Object namespace", for good (found live 2026-10-29;
      // a Worker deployed again after the application started at once).
      await uploadServing();
    }
    const at = { script, url, token };
    const polling = { startTimeoutMs, pollMs };
    /** The deployment `made` answers with once live (`deploymentOf`). */
    const deploymentAt = (made: Upload) =>
      deploymentOf(revision, configurationRevision, image, made.annotations?.["workers/tag"]);
    // 1. Build first: by the deployed Worker's container when it runs the declared image and can
    // (another token, a Worker without the route, a revision whose worker ends: stale); else by
    // R's, which the Worker at R starts, serving visitors the app deployed meanwhile, once that
    // version answers: until then an earlier one may.
    const deployed =
      first || textOf(current?.bindings).get(TEXT.image) !== image
        ? undefined
        : await appBundle(cf, { ...at, revision }, polling);
    const builtAtR = async () => {
      const deployment = await deploymentAt(first ?? (await uploadServing()));
      await live(cf, at, deployment);
      return appBundle(cf, { ...at, revision, deployment }, polling);
    };
    const bundle = deployed && !("stale" in deployed) ? deployed : await builtAtR();
    const jwt = bundle.assets.length ? await uploadAssets(cf, script, bundle.assets) : undefined;
    // 2. One upload, its version tagged with the app's revision.
    await detach();
    const last: Upload = {
      ...worker,
      bindings: withApp(jwt),
      compatibility_date: bundle.compatibilityDate,
      compatibility_flags: bundle.compatibilityFlags,
      ...(jwt && { assets: { jwt, config: ASSETS_CONFIG } }),
      annotations: { "workers/tag": revision },
      modules: [...entry, ...appModules(script, bundle)],
    };
    await cf.upload(script, last);
    for (const [domain, zone] of missing) await cf.attachDomain(script, domain, zone);
    await live(cf, at, await deploymentAt(last));
    // 3. Restart last.
    await restarted(cf, at, revision, configurationRevision);
    const state: ContainerState = {
      id: app.id,
      name,
      image,
      source,
      ref,
      revision,
      ...(configurationRevision && { configurationRevision }),
      port,
      ...(domains && { domains }),
      ...(hostname && { hostname }),
      url: servedAt(hostname, url),
      worker_url: url,
      healthy: true,
    };
    return { id: name, state };
  };

  return {
    import: read,
    read,
    plan,
    create: ({ desired }: { desired: Record<string, unknown> }, call: CallContext) => put(desired, call),
    update: async (
      {
        id,
        desired,
        expect,
      }: { id: string; desired: Record<string, unknown>; expect?: { action: PlanAction; replace: string[] } },
      call: CallContext,
    ) => {
      const fresh = await plan({ id, desired });
      if (fresh.action !== "none") {
        replanned(`${type.type}.update`, fresh, expect);
        return put(desired, call);
      }
      // The Worker runs what is declared: the restart alone, which confirms it (matching bindings
      // also describe a deploy whose restart did not finish). Read and plan remain passive.
      // The token resolved alone: a restart reads no other secret, and uploads none.
      const state = fresh.planned as ContainerState;
      if (!state.revision) throw refused(`container ${id}: no revision to confirm`);
      const declaredToken = (desired.secrets as Record<string, unknown> | null | undefined)?.[WAKEUP_TOKEN];
      const token =
        declaredToken === undefined
          ? await call.secrets.ensure(WAKEUP_TOKEN, mintInstanceToken)
          : String(await resolveSecrets(declaredToken, call.secrets));
      const at = { script: scriptOf(id), url: state.worker_url, token };
      await restarted(api(), at, state.revision, state.configurationRevision);
      return { id, state: { ...state, healthy: true } };
    },
    delete: async ({ id }: { id: string }) => {
      const cf = api();
      const script = scriptOf(id);
      const bindings = (await cf.settings(script))?.bindings;
      if (bindings && !isOurs(bindings)) {
        throw refused(`a Worker named ${script} that is not Sanoma's exists: it is not deleted`, "exists");
      }
      const before = declaredBefore(bindings);
      if (before.size > 0) {
        for (const domain of await cf.domains(script))
          if (before.has(domain.hostname)) await cf.detachDomain(domain.id);
      }
      const app = await cf.application(script);
      if (app) await cf.deleteApplication(app.id);
      await cf.deleteScript(script);
      // After the Worker, which binds it.
      const database = await cf.hyperdrive(script);
      if (database) await cf.deleteHyperdrive(database.id);
      return { id, gone: true as const };
    },
  };
}

/** A host's URL as the alarm keeps it (`instanceUrl`, the wakeup service's rule), or as given when that refuses it. */
const hostUrl = (host: unknown) => {
  const checked = instanceUrl(host);
  return "url" in checked ? checked.url : String(host);
};

/**
 * An alarm's state: the host's, its registered wake and when it last rang, whether the host's
 * Worker took this company's token, and the name of the secret that holds the token (`token`)
 * when it is not the default, so a declared alarm's state is as it was.
 */
const alarmState = (
  host: string,
  wake: { at?: unknown; rang?: unknown } | undefined,
  healthy: boolean,
  token: string,
) => ({
  host,
  at: typeof wake?.at === "string" ? wake.at : null,
  rang: typeof wake?.rang === "string" ? wake.rang : null,
  healthy,
  ...(token !== WAKEUP_TOKEN && { token }),
});

/**
 * The name of the secret that holds the host's wakeup token: the marker `desired.token` gives
 * (`secret("NAME")`), else the one a state names, else `SANOMA_WAKEUP_TOKEN`, a declared alarm's.
 */
function tokenName(desired: Record<string, unknown> | undefined, state: Record<string, unknown> | undefined) {
  const given = desired?.token;
  if (given !== undefined && given !== null) {
    if (!isSecret(given))
      throw refused(`alarm: token names the secret that holds the token, secret("NAME"), not its value`);
    return given.$secret;
  }
  return typeof state?.token === "string" ? state.token : WAKEUP_TOKEN;
}

/** What the host's wake route answered: its status, its JSON, and its own `error` when it gave one. */
interface Answer {
  where: string;
  status: number;
  json: unknown;
  /** The Worker's own `{ error }`: a 404 without it is no Worker of Sanoma's at the URL. */
  own?: string;
}

/** The wake route's refusal, or its failure: retryable as its status is. */
const failed = ({ where, status, own }: Answer, advice?: string) =>
  new DriverError(`cloudflare: ${where}: ${own ?? `HTTP ${status}`}${advice ? `: ${advice}` : ""}`, {
    retryable: retryableStatus(status),
    status,
  });

const NO_TOKEN = `add ${WAKEUP_TOKEN} to the host's secrets (secret("${WAKEUP_TOKEN}", { generate: true })) and apply the host`;

/**
 * `cloudflare.alarm`'s operations and `alarm.register` over `api().send`: the host's own Worker's
 * wake route (`/__sanoma/wake`), each request with the company's `SANOMA_WAKEUP_TOKEN`, read from
 * the secret the alarm's `token` names (`tokenName`; `register` reads the default). `create`
 * mints and stores the token when none is, and the host's URL as `SANOMA_HOST_URL`. `register`
 * sends to the host's URL from the environment, `SANOMA_HOST_URL`, which the Worker sets in the
 * container's; off the host, from the stored one.
 */
export function alarmOps(api: () => Pick<CloudflareApi, "send">) {
  const route = async (host: string, method: string, token: string, body?: unknown): Promise<Answer> => {
    const where = `${method} ${host}${WAKE_PATH}`;
    let res: Response;
    try {
      res = await api().send(`${host}${WAKE_PATH}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new DriverError(`cloudflare: ${where}: no answer (${errorMessage(cause)})`, { retryable: true, cause });
    }
    const json: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    const error = (json as { error?: unknown } | undefined)?.error;
    return { where, status: res.status, json, ...(typeof error === "string" && { own: error }) };
  };

  /** The alarm at `host`, with the token the secret `name` holds: its state, or undefined when no Worker of Sanoma's answers there. */
  const look = async (host: string, token: string, name: string) => {
    const answer = await route(host, "GET", token);
    if (answer.status === 200) return { answer, state: alarmState(host, answer.json as object, true, name) };
    // The Worker's own refusal: it lacks the token, or holds another.
    if ((answer.status === 404 || answer.status === 401) && answer.own) {
      return { answer, state: alarmState(host, undefined, false, name) };
    }
    if (answer.status === 404) return { answer, state: undefined };
    throw failed(answer);
  };

  /** The alarm at `id`, read with the token the secret `name` holds. */
  const readWith = async (id: string, name: string, call: CallContext) => {
    // Without the token, the Worker refuses it: the alarm reads as unhealthy, and a plan to delete it goes on.
    const { state } = await look(id, (await call.secrets.get(name)) ?? "", name);
    return state ? { id, gone: false, state } : { id, gone: true };
  };

  const read = ({ id, state }: { id: string; state?: Record<string, unknown> }, call: CallContext) =>
    readWith(id, tokenName(undefined, state), call);

  const plan = async (
    { id, state: known, desired }: { id?: string; state?: Record<string, unknown>; desired?: Record<string, unknown> },
    call: CallContext,
  ): Promise<Planned> => {
    // Apply plans a declared alarm, and reads and deletes it by its id alone, with the default token.
    if (desired && tokenName(desired, undefined) !== WAKEUP_TOKEN) {
      throw refused(`alarm: a declared alarm's token is ${WAKEUP_TOKEN}: leave token out of the data file`);
    }
    const state = id === undefined ? undefined : (await readWith(id, tokenName(undefined, known), call)).state;
    if (!desired) return { action: state ? "delete" : "none", ...NONE };
    const planned = { host: hostUrl(desired.host) };
    const unknown = [...alarm.fields.vendorOwned];
    if (!state) return { action: "create", planned, unknown, replace: [] };
    // The alarm is the host's object's: a new host is a new alarm.
    if (planned.host !== state.host) return { action: "replace", planned, unknown, replace: ["host"] };
    return { action: "none", planned: state, ...NONE };
  };

  return {
    import: read,
    read,
    plan,
    create: async ({ desired }: { desired: Record<string, unknown> }, { secrets }: CallContext) => {
      const host = hostUrl(desired.host);
      const name = tokenName(desired, undefined);
      const token = await secrets.ensure(name, mintInstanceToken);
      const { answer, state } = await look(host, token, name);
      if (!state) throw failed(answer, "no Worker of Sanoma's answers there: apply the host first");
      // A declared host is applied; a workflow's own host, under a name of its own, is updated with it.
      const own = name === WAKEUP_TOKEN ? undefined : `update the host with ${WAKEUP_TOKEN}: secret("${name}")`;
      if (answer.status === 404) {
        throw refused(`alarm.create: the host has no ${WAKEUP_TOKEN}: ${own ?? NO_TOKEN}`, "no_token");
      }
      if (answer.status === 401) {
        const advice = own ?? "apply the host again";
        throw refused(`alarm.create: the host's ${WAKEUP_TOKEN} is not the stored ${name}: ${advice}`, "token");
      }
      // Only for a register made off the host (a test's, a kit's): on it, the Worker's binding comes first.
      await secrets.ensure(HOST_URL, () => host);
      return { id: host, state };
    },
    update: async (
      { id, state: known, desired }: { id: string; state?: Record<string, unknown>; desired: Record<string, unknown> },
      call: CallContext,
    ) => {
      const { state } = await readWith(id, tokenName(desired, known), call);
      if (!state || hostUrl(desired.host) !== state.host) {
        throw refused(`alarm.update: a new host is a new alarm`, "plan_changed");
      }
      return { id, state };
    },
    delete: async ({ id, state }: { id: string; state?: Record<string, unknown> }, { secrets }: CallContext) => {
      // Without the token it is still asked: a host that is gone answers 404, one that holds a wake refuses.
      const answer = await route(id, "DELETE", (await secrets.get(tokenName(undefined, state))) ?? "");
      if (answer.status !== 204 && answer.status !== 404) throw failed(answer);
      return { id, gone: true as const };
    },
    register: async (registration: WakeupRegistration, call: CallContext) => {
      const token = await call.secrets.get(WAKEUP_TOKEN);
      if (!token) throw refused(`alarm.register: ${WAKEUP_TOKEN} is not set: apply the alarm, which mints it`);
      // On the host, the Worker's binding is in the environment; off it, only a stored one names the host.
      const host = process.env[HOST_URL] || (await call.secrets.get(HOST_URL));
      if (!host) {
        throw refused(
          `alarm.register: ${HOST_URL} is set neither in the environment (the Worker sets it on the host) nor among the stored credentials (apply the alarm, which stores it)`,
        );
      }
      const answer = await route(hostUrl(host), "PUT", token, registration);
      if (answer.status === 204) return {};
      throw failed(answer, answer.status === 404 && answer.own ? NO_TOKEN : undefined);
    },
  };
}
