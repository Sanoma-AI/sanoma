import { setTimeout as delay } from "node:timers/promises";
import {
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
import { domainsOf, domainsText } from "@sanoma-ai/workflows/shared";
import { instanceUrl, mintInstanceToken, WAKEUP_TOKEN } from "@sanoma-ai/workflows/wakeup-service";
import { alarm, container } from "./connector.ts";
import { accountPinned } from "./registry.ts";
import {
  HEALTH_PATH,
  IMAGE,
  MAIN_MODULE,
  NAMESPACE,
  OBJECT_CLASS,
  type WorkerModule,
  workerModules,
} from "./worker.ts";

// Cloudflare as the operations use it (`CloudflareApi`), and the container's and the alarm's
// operations over it: the driver's calls its API with the SDK and the Worker over HTTP, the
// fake's answers from its state and its Worker in this process. Both go through `containerOps`
// and `alarmOps` (and `recordsOps`, in `records.ts`), so they upload, plan and refuse alike.

/** The Workers runtime the Worker is written for. */
export const COMPATIBILITY_DATE = "2026-10-01";
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
  url: HOST_URL,
} as const;
/** Names a secret may not take: the Worker's own bindings. */
const RESERVED = new Set<string>([NAMESPACE, ...Object.values(TEXT)]);

/** A binding as the upload sends it. */
export type Binding =
  | { type: "durable_object_namespace"; name: string; class_name: string }
  | { type: "plain_text" | "secret_text"; name: string; text: string };

/** A binding as a read shows it: a secret's name, never its text. */
export interface ReadBinding {
  type: string;
  name: string;
  text?: string;
  /** A Durable Object namespace's id, which the container application is made for. */
  namespace_id?: string;
}

/** Whether a Worker's bindings are Sanoma's: its own object's namespace among them. */
const isOurs = (bindings: ReadBinding[]) =>
  bindings.some((b) => b.type === "durable_object_namespace" && b.name === NAMESPACE);

/** The upload's metadata and modules (`PUT …/workers/scripts/{name}`). */
export interface Upload {
  main_module: string;
  compatibility_date: string;
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
  /** The Worker's bindings (`GET …/scripts/{name}/settings`); undefined when there is no such Worker. */
  bindings(script: string): Promise<ReadBinding[] | undefined>;
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
  /** A request to a Worker: its answer, or a throw when there is none. */
  send(url: string, init: RequestInit): Promise<Response>;
}

/** The driver's own refusal, before or instead of a call: never retried. */
export const refused = (message: string, vendorCode?: string) =>
  new DriverError(`cloudflare: ${message}`, { retryable: false, ...(vendorCode && { vendorCode }) });

/** The company's Worker, named after it. */
export const scriptOf = (name: string) => `sanoma-${name}`;

/** The zone a hostname is looked up in: its last two labels (`www.acme.example` → `acme.example`). */
export const apexOf = (hostname: string) => hostname.split(".").slice(-2).join(".");

/**
 * The hostnames the Worker's bindings say it was declared to serve (`SANOMA_DOMAINS`): the custom
 * domains that are Sanoma's to detach. One attached by hand and never declared is left alone.
 */
const declaredBefore = (bindings: ReadBinding[] | undefined) => {
  const text = bindings?.find((b) => b.type === "plain_text" && b.name === TEXT.domains)?.text;
  return new Set(text ? Object.values(domainsOf(text)) : []);
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
  url: string;
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
const COMPARED = ["image", "source", "ref", "revision", "configurationRevision", "port", "domains"] as const;
const same = (field: (typeof COMPARED)[number], a: unknown, b: unknown) =>
  field === "domains"
    ? domainsText((a ?? {}) as Record<string, string>) === domainsText((b ?? {}) as Record<string, string>)
    : field === "configurationRevision"
      ? (a ?? "") === (b ?? "")
      : a === b;

/**
 * `{ revision }` when the Worker answers, else why not; with `start`, once its container answers
 * too, which starts it. A read asks without: a stopped host is healthy, and stays stopped. A
 * container that ended is `exit`: the Worker would start it again on the next ask, so a deploy
 * stops asking.
 */
const health = async (
  cf: CloudflareApi,
  url: string,
  start: boolean,
): Promise<{ revision: string; configurationRevision?: string } | { error: string; exit: boolean }> => {
  let res: Response;
  try {
    res = await cf.send(`${url}${HEALTH_PATH}${start ? "?start=1" : ""}`, { method: "GET" });
  } catch (error) {
    return { error: errorMessage(error), exit: false };
  }
  const body = (await res.json().catch(() => undefined)) as
    | { revision?: unknown; configurationRevision?: unknown; error?: unknown; exit?: unknown }
    | undefined;
  if (res.ok && typeof body?.revision === "string")
    return {
      revision: body.revision,
      ...(typeof body.configurationRevision === "string" && { configurationRevision: body.configurationRevision }),
    };
  const error = typeof body?.error === "string" ? body.error : `${HEALTH_PATH} answered ${res.status}`;
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

export interface ContainerOptions {
  /** How long a create or update waits for the Worker to answer at its new revision. */
  startTimeoutMs: number;
  /** How long between two tries. */
  pollMs: number;
}

/**
 * `cloudflare.container`'s operations over `api()`, made on each call. A create and an update
 * are one upsert, in Wrangler's order: the image copied and pinned, then prepared, the Worker
 * uploaded with the declared bindings and that image (the migration on its first upload), its
 * workers.dev URL turned on, the application made when there is none, and then a wait until the
 * Worker answers at the new revision, which starts the container. A new image is a new upload:
 * the object destroys a container started at another and starts it again.
 */
export function containerOps(api: () => CloudflareApi, { startTimeoutMs, pollMs }: ContainerOptions) {
  /** The Worker `name` runs, from its bindings and its application; `checkHealth` asks it too. None for a Worker that is not Sanoma's. */
  const inspect = async (name: string, checkHealth: boolean) => {
    const cf = api();
    const script = scriptOf(name);
    const bindings = await cf.bindings(script);
    if (!bindings || !isOurs(bindings)) return undefined;
    const app = await cf.application(script);
    const url = await cf.workerUrl(script);
    const text = new Map(bindings.filter((b) => b.type === "plain_text").map((b) => [b.name, b.text ?? ""]));
    const served = text.get(TEXT.domains);
    // The domains it serves that are attached: one whose attach failed, or detached by hand, is
    // drift, so the next apply attaches it again.
    let domains: Record<string, string> | undefined;
    if (served) {
      const attached = new Set((await cf.domains(script)).map((d) => d.hostname));
      domains = Object.fromEntries(Object.entries(domainsOf(served)).filter(([, hostname]) => attached.has(hostname)));
    }
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
      url,
      healthy: checkHealth && app !== undefined && "revision" in (await health(cf, url, false)),
    };
    const secrets = bindings.filter((b) => b.type === "secret_text").map((b) => b.name);
    return { state, secrets };
  };

  const read = async ({ id }: { id: string }) => {
    const found = await inspect(id, true);
    return found ? { id, gone: false, state: found.state } : { id, gone: true };
  };

  const plan = async ({ id, desired }: { id?: string; desired?: Record<string, unknown> }): Promise<Planned> => {
    const found = id === undefined ? undefined : await inspect(id, false);
    if (!desired) return { action: found ? "delete" : "none", ...NONE };
    const { secrets, ...declared } = desired;
    const unknown = [...container.fields.vendorOwned];
    // A create plans without the account: it needs no credentials yet.
    if (!found) return { action: "create", planned: declared, unknown, replace: [] };
    const planned: Record<string, unknown> = declared;
    const { state } = found;
    if (planned.name !== state.name) return { action: "replace", planned, unknown, replace: ["name"] };
    const changed =
      // `domains` left out is compared too: removing them is a change.
      COMPARED.some(
        (field) =>
          (field in planned || field === "domains" || field === "configurationRevision") &&
          !same(field, planned[field], state[field]),
      ) || sorted(Object.keys(secrets ?? {})) !== sorted(found.secrets);
    if (!changed) return { action: "none", planned: state, ...NONE };
    return {
      action: "update",
      planned: {
        ...state,
        ...planned,
        ...(state.configurationRevision !== undefined &&
          planned.configurationRevision == null && { configurationRevision: null }),
      },
      ...NONE,
    };
  };

  /** Waits until the Worker at `url` answers at `revision`, which starts its container. */
  const started = async (
    cf: CloudflareApi,
    script: string,
    url: string,
    revision: string,
    configurationRevision?: string | null,
  ) => {
    const until = Date.now() + startTimeoutMs;
    for (;;) {
      const seen = await health(cf, url, true);
      if (
        "revision" in seen &&
        seen.revision === revision &&
        (seen.configurationRevision ?? "") === (configurationRevision ?? "")
      )
        return;
      // Not a wait: the container started and ended, and asking again would only start it again.
      if ("exit" in seen && seen.exit) throw refused(`${script} did not start at ${revision}: ${seen.error}`);
      if (Date.now() >= until) {
        const why =
          "revision" in seen
            ? `it runs ${seen.revision} with configuration ${seen.configurationRevision ?? "unset"}`
            : seen.error;
        throw refused(`${script} did not answer at ${revision} in ${Math.round(startTimeoutMs / 1000)} s: ${why}`);
      }
      await delay(pollMs);
    }
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

  /** Makes the Worker and its application match `desired`, and waits for it: a create and an update alike. */
  const put = async (desired: Record<string, unknown>, { secrets: store }: CallContext) => {
    const declared = container.schema.parse(await resolveSecrets(desired, store));
    const { name, image, source, ref, revision, configurationRevision, port, domains } = declared;
    const secrets = declared.secrets ?? {};
    if (!revision) {
      throw refused(
        `container ${name}: no revision: apply sets it from ${ref} once its source exists (apply again after a repository it creates)`,
      );
    }
    const taken = Object.keys(secrets).filter((key) => RESERVED.has(key));
    if (taken.length)
      throw refused(`container ${name}: ${taken.join(", ")} is the Worker's own; name the secret otherwise`);
    const cf = api();
    const script = scriptOf(name);
    const url = await cf.workerUrl(script);
    const current = await cf.bindings(script);
    if (current && !isOurs(current)) {
      throw refused(
        `a Worker named ${script} that is not Sanoma's exists: delete it, or name the host otherwise`,
        "exists",
      );
    }
    // Copied and prepared before anything changes, so a copy or a preparation that fails leaves
    // the Worker as it was. Each apply asks again, which costs a manifest's HEAD once the copy is
    // there, and puts back one gone; the object starts only a pinned image of the account's.
    // The custom domains are read first too: the ones an update's Worker has, and each declared
    // one missing, with its zone, so a domain whose zone the account lacks is refused here.
    const before = declaredBefore(current);
    const attached = current && (domains || before.size > 0) ? await cf.domains(script) : [];
    const held = new Set(attached.map((d) => d.hostname));
    const missing = await zonesOf(
      cf,
      name,
      Object.values(domains ?? {}).filter((hostname) => !held.has(hostname)),
    );
    const runs = accountPinned(image, cf.account) ? image : await cf.copyImage(image);
    await prepared(cf, runs);
    const served = domains ? domainsText(domains) : undefined;
    const text = {
      [TEXT.source]: source,
      [TEXT.ref]: ref,
      [TEXT.revision]: revision,
      ...(configurationRevision && { [TEXT.configurationRevision]: configurationRevision }),
      [TEXT.image]: image,
      [TEXT.port]: String(port),
      [TEXT.url]: url,
      ...(served && { [TEXT.domains]: served }),
    };
    const bindings: Binding[] = [
      { type: "durable_object_namespace", name: NAMESPACE, class_name: OBJECT_CLASS },
      ...Object.entries(text).map(([key, value]) => ({ type: "plain_text" as const, name: key, text: value })),
      ...Object.entries(secrets).map(([key, value]) => ({
        type: "secret_text" as const,
        name: key,
        text: value,
      })),
    ];
    const metadata = {
      main_module: MAIN_MODULE,
      compatibility_date: COMPATIBILITY_DATE,
      bindings,
      containers: [{ name: script, class_name: OBJECT_CLASS, images: { [IMAGE]: runs } }],
      observability: { enabled: true },
      modules: await workerModules(),
    };
    await cf.upload(script, { ...metadata, ...(current === undefined && { migrations: MIGRATION }) });
    await cf.enableSubdomain(script);
    let app = await cf.application(script);
    if (!app) {
      // The application is made for the object's namespace, which the first upload made.
      const namespace = (await cf.bindings(script))?.find((b) => b.name === NAMESPACE)?.namespace_id;
      if (!namespace) throw refused(`${script}: Cloudflare names no namespace for its ${NAMESPACE} binding`);
      app = await cf.createApplication(script, namespace);
      // The object learns which application backs its namespace from a deployment made after
      // the application exists: without this second upload every start answers "There is no
      // container application assigned to this Durable Object namespace", for good (found live
      // 2026-10-29; a Worker deployed again after the application started at once).
      await cf.upload(script, metadata);
    }
    // The declared domains routed to the Worker, attached first so a failed attach leaves the old
    // route up; then the ones declared before and no longer, detached.
    for (const [hostname, zoneId] of missing) await cf.attachDomain(script, hostname, zoneId);
    const hostnames = new Set(Object.values(domains ?? {}));
    for (const domain of attached) {
      if (before.has(domain.hostname) && !hostnames.has(domain.hostname)) await cf.detachDomain(domain.id);
    }
    await started(cf, script, url, revision, configurationRevision);
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
      url,
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
      replanned("container.update", fresh, expect);
      if (fresh.action === "none") {
        const found = await read({ id });
        if (found.state) return { id, state: found.state };
      }
      return put(desired, call);
    },
    delete: async ({ id }: { id: string }) => {
      const cf = api();
      const script = scriptOf(id);
      const bindings = await cf.bindings(script);
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
