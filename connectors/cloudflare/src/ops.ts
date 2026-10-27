import {
  type CallContext,
  DriverError,
  errorMessage,
  type PlanAction,
  resolveSecrets,
  retryableStatus,
  type WakeupRegistration,
} from "@sanoma-ai/workflows";
import { domainsOf, domainsText } from "@sanoma-ai/workflows/shared";
import { instanceUrl, mintInstanceToken, WAKEUP_TOKEN } from "@sanoma-ai/workflows/wakeup-service";
import { alarm, container } from "./connector.ts";
import {
  HEALTH_PATH,
  MAIN_MODULE,
  NAMESPACE,
  OBJECT_CLASS,
  WAKE_PATH,
  type WorkerModule,
  workerModules,
} from "./worker.ts";

// Both types' operations over Cloudflare (`CloudflareApi`): the driver's calls its API with the
// SDK and the Worker over HTTP, the fake's answers from its state and its Worker in this process.
// Both go through `containerOps` and `alarmOps`, so they upload, plan and refuse alike.

/** The Workers runtime the Worker is written for. */
export const COMPATIBILITY_DATE = "2026-10-01";
/** The migration that makes the Worker's object class, on its first upload only. */
export const MIGRATION = { new_tag: "v1", new_sqlite_classes: [OBJECT_CLASS] };
/**
 * The host's own URL, which the Worker gives the container and `alarm.create` stores: where
 * `alarm.register` sends the wake, as the registration names no host.
 */
export const HOST_URL = "SANOMA_HOST_URL";

/** The plain-text bindings that say what the Worker runs: a read reads them back. */
const TEXT = {
  source: "SANOMA_SOURCE",
  ref: "SANOMA_REF",
  revision: "SANOMA_REVISION",
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
  /** The object classes that run a container: the namespace is container-enabled. */
  containers: { class_name: string }[];
  /** On the first upload only. */
  migrations?: typeof MIGRATION;
  modules: WorkerModule[];
}

/** A container application, as the fields read here. */
export interface Application {
  id: string;
  image: string;
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
  /** The image the application runs for a declared one: itself in Cloudflare's registry, else its copy in the account's (`accountImage`). */
  accountImage(image: string): string;
  /** Copies a declared image into the account's registry unless it is there already; the image the application runs. */
  copyImage(image: string): Promise<string>;
  /** Deletes the Worker, its object's storage with it; nothing when there is none. */
  deleteScript(script: string): Promise<void>;
  /** The container application of that name, if any (`GET …/containers/applications?name=`). */
  application(name: string): Promise<Application | undefined>;
  /** Makes the application behind the Worker's object: `default` policy, `basic`, one instance at most. */
  createApplication(name: string, image: string, namespaceId: string): Promise<Application>;
  /** Rolls the application out to a new image (`POST …/applications/{id}/rollouts`). */
  rollout(id: string, image: string): Promise<void>;
  /** Deletes the application; nothing when there is none. */
  deleteApplication(id: string): Promise<void>;
  /** A request to a Worker: its answer, or a throw when there is none. */
  send(url: string, init: RequestInit): Promise<Response>;
}

/** The driver's own refusal, before or instead of a call: never retried. */
export const refused = (message: string, vendorCode?: string) =>
  new DriverError(`cloudflare: ${message}`, { retryable: false, ...(vendorCode && { vendorCode }) });

/** The company's Worker, named after it. */
export const scriptOf = (name: string) => `sanoma-${name}`;

type ContainerState = {
  id: string | null;
  name: string;
  image: string;
  source: string;
  ref: string;
  revision: string | null;
  port: number;
  domains?: Record<string, string>;
  url: string;
  healthy: boolean;
};

/** What a plan of a change finds, and the state it planned from. */
interface Planned {
  action: PlanAction;
  planned?: Record<string, unknown>;
  unknown: string[];
  replace: string[];
}

const NONE = { unknown: [], replace: [] };
const sorted = (names: Iterable<string>) => [...names].toSorted().join(",");

/** The declared fields a change of which is an update: everything the Worker runs, and the image. */
const COMPARED = ["image", "source", "ref", "revision", "port", "domains"] as const;
const same = (field: (typeof COMPARED)[number], a: unknown, b: unknown) =>
  field === "domains"
    ? domainsText((a ?? {}) as Record<string, string>) === domainsText((b ?? {}) as Record<string, string>)
    : a === b;

/**
 * `{ revision }` when the Worker answers, else why not; with `start`, once its container answers
 * too, which starts it. A read asks without: a stopped host is healthy, and stays stopped.
 */
const health = async (cf: CloudflareApi, url: string, start: boolean): Promise<{ revision: string } | string> => {
  let res: Response;
  try {
    res = await cf.send(`${url}${HEALTH_PATH}${start ? "?start=1" : ""}`, { method: "GET" });
  } catch (error) {
    return errorMessage(error);
  }
  const body = (await res.json().catch(() => undefined)) as { revision?: unknown; error?: unknown } | undefined;
  if (res.ok && typeof body?.revision === "string") return { revision: body.revision };
  return typeof body?.error === "string" ? body.error : `${HEALTH_PATH} answered ${res.status}`;
};

export interface ContainerOptions {
  /** How long a create or update waits for the Worker to answer at its new revision. */
  startTimeoutMs: number;
  /** How long between two tries. */
  pollMs: number;
}

/**
 * `cloudflare.container`'s operations over `api()`, made on each call. A create and an update
 * are one upsert: the Worker uploaded with the declared bindings (the migration on its first
 * upload), its workers.dev URL turned on, the application made or rolled out to a new image, and
 * then a wait until the Worker answers at the new revision, which starts the container.
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
    const state: ContainerState = {
      id: app?.id ?? null,
      name,
      image: app?.image ?? "",
      source: text.get(TEXT.source) ?? "",
      ref: text.get(TEXT.ref) ?? "",
      revision: text.get(TEXT.revision) ?? null,
      port: Number(text.get(TEXT.port) ?? 0),
      ...(served && { domains: domainsOf(served) }),
      url,
      healthy: checkHealth && app !== undefined && typeof (await health(cf, url, false)) === "object",
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
    const { secrets, ...planned } = desired;
    const unknown = [...container.fields.vendorOwned];
    if (!found) return { action: "create", planned, unknown, replace: [] };
    const { state } = found;
    if (planned.name !== state.name) return { action: "replace", planned, unknown, replace: ["name"] };
    // The application runs the image's copy in the account's registry: that is what a read shows.
    const runs: Record<string, unknown> = { ...planned };
    if (typeof planned.image === "string") runs.image = api().accountImage(planned.image);
    const changed =
      // `domains` left out is compared too: removing them is a change.
      COMPARED.some((field) => (field in planned || field === "domains") && !same(field, runs[field], state[field])) ||
      sorted(Object.keys(secrets ?? {})) !== sorted(found.secrets);
    if (!changed) return { action: "none", planned: state, ...NONE };
    return { action: "update", planned: { ...state, ...runs }, ...NONE };
  };

  /** Waits until the Worker at `url` answers at `revision`, which starts its container. */
  const started = async (cf: CloudflareApi, script: string, url: string, revision: string) => {
    const until = Date.now() + startTimeoutMs;
    for (;;) {
      const seen = await health(cf, url, true);
      if (typeof seen === "object" && seen.revision === revision) return;
      if (Date.now() >= until) {
        const why = typeof seen === "object" ? `it runs ${seen.revision}` : seen;
        throw refused(`${script} did not answer at ${revision} in ${Math.round(startTimeoutMs / 1000)} s: ${why}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };

  /** Makes the Worker and its application match `desired`, and waits for it: a create and an update alike. */
  const put = async (desired: Record<string, unknown>, { secrets: store }: CallContext) => {
    const declared = container.schema.parse(await resolveSecrets(desired, store));
    const { name, image, source, ref, revision, port, domains } = declared;
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
    // Before anything changes: a copy that fails leaves the Worker as it was.
    const runs = await cf.copyImage(image);
    const served = domains ? domainsText(domains) : undefined;
    const text = {
      [TEXT.source]: source,
      [TEXT.ref]: ref,
      [TEXT.revision]: revision,
      [TEXT.image]: runs,
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
    await cf.upload(script, {
      main_module: MAIN_MODULE,
      compatibility_date: COMPATIBILITY_DATE,
      bindings,
      containers: [{ class_name: OBJECT_CLASS }],
      ...(current === undefined && { migrations: MIGRATION }),
      modules: await workerModules(),
    });
    await cf.enableSubdomain(script);
    let app = await cf.application(script);
    if (!app) {
      // The application is made for the object's namespace, which the first upload made.
      const namespace = (await cf.bindings(script))?.find((b) => b.name === NAMESPACE)?.namespace_id;
      if (!namespace) throw refused(`${script}: Cloudflare names no namespace for its ${NAMESPACE} binding`);
      app = await cf.createApplication(script, runs, namespace);
    } else if (app.image !== runs) await cf.rollout(app.id, runs);
    await started(cf, script, url, revision);
    const state: ContainerState = {
      id: app.id,
      name,
      image: runs,
      source,
      ref,
      revision,
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
      if (expect && (expect.action !== fresh.action || expect.replace.join() !== fresh.replace.join())) {
        throw refused(`container.update: the plan changed (${expect.action}, now ${fresh.action})`, "plan_changed");
      }
      if (fresh.action !== "update" && fresh.action !== "none") {
        throw refused(`container.update: the plan is a ${fresh.action}, not an update`, "plan_changed");
      }
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

/** An alarm's state: the host's, its registered wake and when it last rang, and whether the host's Worker took this company's token. */
const alarmState = (host: string, wake: { at?: unknown; rang?: unknown } | undefined, healthy: boolean) => ({
  host,
  at: typeof wake?.at === "string" ? wake.at : null,
  rang: typeof wake?.rang === "string" ? wake.rang : null,
  healthy,
});

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
 * wake route (`/__sanoma/wake`), each request with the company's `SANOMA_WAKEUP_TOKEN`. `create`
 * mints and stores the token when none is, and stores the host's URL as `SANOMA_HOST_URL` for a
 * register made off the host (on it, the Worker sets it in the container's environment).
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

  /** The alarm at `host`: its state, or undefined when no Worker of Sanoma's answers there. */
  const look = async (host: string, token: string) => {
    const answer = await route(host, "GET", token);
    if (answer.status === 200) return { answer, state: alarmState(host, answer.json as object, true) };
    // The Worker's own refusal: it lacks the token, or holds another.
    if ((answer.status === 404 || answer.status === 401) && answer.own) {
      return { answer, state: alarmState(host, undefined, false) };
    }
    if (answer.status === 404) return { answer, state: undefined };
    throw failed(answer);
  };

  const read = async ({ id }: { id: string }, call: CallContext) => {
    // Without the token, the Worker refuses it: the alarm reads as unhealthy, and a plan to delete it goes on.
    const { state } = await look(id, (await call.secrets.get(WAKEUP_TOKEN)) ?? "");
    return state ? { id, gone: false, state } : { id, gone: true };
  };

  const plan = async (
    { id, desired }: { id?: string; desired?: Record<string, unknown> },
    call: CallContext,
  ): Promise<Planned> => {
    const state = id === undefined ? undefined : (await read({ id }, call)).state;
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
      const token = await secrets.ensure(WAKEUP_TOKEN, mintInstanceToken);
      const { answer, state } = await look(host, token);
      if (!state) throw failed(answer, "no Worker of Sanoma's answers there: apply the host first");
      if (answer.status === 404)
        throw refused(`alarm.create: the host has no ${WAKEUP_TOKEN}: ${NO_TOKEN}`, "no_token");
      if (answer.status === 401) {
        throw refused(`alarm.create: the host's ${WAKEUP_TOKEN} is not the stored one: apply the host again`, "token");
      }
      // For a register made off the host: on it, the Worker's SANOMA_HOST_URL is in the environment, which comes first.
      await secrets.ensure(HOST_URL, () => host);
      return { id: host, state };
    },
    update: async ({ id, desired }: { id: string; desired: Record<string, unknown> }, call: CallContext) => {
      const { state } = await read({ id }, call);
      if (!state || hostUrl(desired.host) !== state.host) {
        throw refused(`alarm.update: a new host is a new alarm`, "plan_changed");
      }
      return { id, state };
    },
    delete: async ({ id }: { id: string }, { secrets }: CallContext) => {
      // Without the token it is still asked: a host that is gone answers 404, one that holds a wake refuses.
      const answer = await route(id, "DELETE", (await secrets.get(WAKEUP_TOKEN)) ?? "");
      if (answer.status !== 204 && answer.status !== 404) throw failed(answer);
      return { id, gone: true as const };
    },
    register: async (registration: WakeupRegistration, call: CallContext) => {
      const token = await call.secrets.get(WAKEUP_TOKEN);
      if (!token) throw refused(`alarm.register: ${WAKEUP_TOKEN} is not set: apply the alarm, which mints it`);
      const host = await call.secrets.get(HOST_URL);
      if (!host) throw refused(`alarm.register: ${HOST_URL} is not set: apply the alarm, which stores it`);
      const answer = await route(hostUrl(host), "PUT", token, registration);
      if (answer.status === 204) return {};
      throw failed(answer, answer.status === 404 && answer.own ? NO_TOKEN : undefined);
    },
  };
}
