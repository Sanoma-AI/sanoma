import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DriverError, errorMessage, retryableStatus } from "@sanoma-ai/workflows";
import { defineFake, type FakeOptions } from "@sanoma-ai/workflows/fake";
import { NodeRequest, sendNodeResponse } from "srvx/node";
import { caaContent, cloudflareOps } from "./connector.ts";
import {
  alarmOps,
  type Application,
  type CloudflareApi,
  containerOps,
  inZone,
  type ReadBinding,
  type RecordWrite,
  scriptOf,
  type ZoneRecord,
} from "./ops.ts";
import { recordsOps } from "./records.ts";
import { accountImage, accountPinned, pinImage } from "./registry.ts";
import { Instance, OBJECT_CLASS, type ObjectState, worker } from "./worker.ts";

/** A `GET /wake` a container answered: when. */
export interface FakeWake {
  at: Date;
}

/** What `start` runs for a container: a runtime answering at `url`, until `stop`. */
export interface FakeContainer {
  url: string;
  stop(): Promise<void>;
  /** Each `/wake` it answered, in order, when it records them. */
  wakes?: readonly FakeWake[];
}

/** Starts the company's runtime, as the container would: the image (the one its pinned copy was copied from), the revision its label names, and the Worker's text bindings as its environment. */
export type StartContainer = (input: {
  image: string;
  revision: string;
  env: Record<string, string>;
}) => Promise<FakeContainer>;

export interface FakeCloudflareOptions extends FakeOptions {
  /** What a container runs. Default: a stub that answers `/healthz` 200 and `/wake` 204. */
  start?: StartContainer;
  /** The zones the account holds, by name. Default: every one asked for, as a sandbox's account holds its domains. */
  zones?: readonly string[];
}

export interface FakeCloudflareState extends Record<string, unknown> {
  seq: number;
  /**
   * The Workers, by script name: their bindings, a secret's without its text, the images their
   * object may start, by name, their entry and modules' names, and the assets their last upload
   * redeemed, each path's hash.
   */
  scripts: Record<
    string,
    {
      bindings: ReadBinding[];
      subdomain: boolean;
      images: Record<string, string>;
      main_module?: string;
      modules?: string[];
      assets?: Record<string, string>;
    }
  >;
  /** The account's assets, by hash: the type each was uploaded with (the content is not kept). */
  assets: Record<string, string>;
  /** The container applications, by id. */
  applications: Record<string, Application & { name: string }>;
  /** The account's registry: each image copied in, by its pinned reference there, and the image it was copied from. */
  images: Record<string, string>;
  /** The account's zones looked up so far: each one's id, by name. */
  zones: Record<string, string>;
  /** The Workers' custom domains, by id: the hostname, the Worker it routes to and its zone's id. */
  domains: Record<string, { hostname: string; service: string; zone_id: string }>;
  /** Each zone's DNS records, by the zone's name: any set's, and any added by hand (a test's). */
  dns: Record<string, ZoneRecord[]>;
}

/** The fake account's id, which its registry's references name: the fixtures' made-up one. */
const FAKE_ACCOUNT = "0123456789abcdef0123456789abcdef";

/** The named sizes `start` takes under the policy: `basic` is not one of them (the runtime refuses it, as it did live on 2026-10-28). */
const INSTANCE_TYPES = ["lite", "standard-1", "standard-2", "standard-3", "standard-4"];

/** How long the fake waits before it rings an alarm again that threw, and how often: Cloudflare retries six times. */
const RETRY_MS = 250;
const RETRIES = 6;
/** setTimeout's longest delay: a longer one fires at once. */
const MAX_DELAY_MS = 2 ** 31 - 1;
/** Headers `fetch` refuses to send, or that no longer hold once it decoded a body. */
const HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "content-encoding"];

const fail = (status: number, code: number, message: string) =>
  new DriverError(`cloudflare: ${message}`, { retryable: retryableStatus(status), status, vendorCode: String(code) });

/** A record as the zone `zone` holds a write of it: a CAA record's fields as its content, a name outside the zone refused. */
function dnsRecordOf(zone: string, { type, name, ttl, comment, proxied, content, priority, data }: RecordWrite) {
  if (!inZone(name, zone)) {
    throw fail(400, 9005, `dns_records/batch: ${name} is not in the zone ${zone}`);
  }
  return {
    type,
    name,
    content: data ? caaContent(data) : (content ?? ""),
    ttl,
    ...(priority !== undefined && { priority }),
    comment,
    proxied,
  };
}

/** workers.dev's answer for a name with no Worker behind it. */
const nothingHere = () =>
  new Response("<!doctype html><title>There is nothing here yet</title>", {
    status: 404,
    headers: { "content-type": "text/html" },
  });

/** A runtime that answers `/healthz` and records each `/wake`: what a container runs unless the fake is given `start`. */
const stubContainer: StartContainer = async () => {
  const wakes: FakeWake[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://container");
    if (url.pathname === "/healthz") return void res.writeHead(200).end("ok\n");
    if (url.pathname !== "/wake") return void res.writeHead(404).end();
    wakes.push({ at: new Date() });
    res.writeHead(204).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  server.unref();
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    wakes,
    stop: () => new Promise<void>((done) => server.close(() => done())),
  };
};

/**
 * One Durable Object of a Worker, in this process: the `ctx` `worker/instance.js` runs over
 * (`ctx.container` running `start`'s runtime, `ctx.storage` in memory, one alarm on a timer),
 * kept across uploads as Cloudflare keeps an object's storage and container across a deploy.
 * `images` are the ones the Worker's last upload named, by name; `source` names the image a
 * pinned one was copied from, or nothing when no application runs behind the object.
 */
function fakeObject(
  start: StartContainer,
  images: () => Record<string, string>,
  source: (image: string) => string | undefined,
  started: FakeContainer[],
) {
  const storage = new Map<string, unknown>();
  let running:
    | { runtime: Promise<FakeContainer>; image: string; labels: Record<string, string>; port: number }
    | undefined;
  let alarm: { at: number; timer?: NodeJS.Timeout } | undefined;
  let ringing: Promise<void> | undefined;
  let inactivityMs: number | undefined;
  let quiet: NodeJS.Timeout | undefined;
  let open = 0;
  let instance: Instance | undefined;

  const destroy = async () => {
    clearTimeout(quiet);
    const was = running;
    running = undefined;
    await was?.runtime.then(
      (runtime) => runtime.stop(),
      () => undefined,
    );
  };
  /** Runs `work` as a request to the object: the container's inactivity counts from the last one's end. */
  const active = async <T>(work: () => Promise<T>): Promise<T> => {
    open++;
    clearTimeout(quiet);
    try {
      return await work();
    } finally {
      open--;
      if (open === 0 && running && inactivityMs !== undefined) {
        quiet = setTimeout(() => void destroy(), inactivityMs).unref();
      }
    }
  };
  /** Rings the alarm `armed`, while it is the one set, again after a throw, six times at most. */
  const ring = async (armed: NonNullable<typeof alarm>) => {
    for (let tries = 0; alarm === armed; tries++) {
      // Cloudflare clears the alarm as it runs it: one set in `alarm()` is a new one.
      alarm = undefined;
      try {
        await active(() => instance!.alarm());
        return;
      } catch (err) {
        console.warn(`cloudflare fake: an alarm threw: ${errorMessage(err)}`);
        if (alarm !== undefined || tries >= RETRIES) return;
        alarm = armed;
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  };
  const schedule = (armed: NonNullable<typeof alarm>) => {
    clearTimeout(armed.timer);
    const due = armed.at - Date.now();
    armed.timer = setTimeout(
      () => {
        if (alarm !== armed) return;
        if (armed.at > Date.now()) return schedule(armed);
        ringing = ring(armed).finally(() => (ringing = undefined));
      },
      Math.min(Math.max(0, due), MAX_DELAY_MS),
    ).unref();
  };
  const disarm = () => {
    clearTimeout(alarm?.timer);
    alarm = undefined;
  };

  const ctx: ObjectState = {
    container: {
      get running() {
        return running !== undefined;
      },
      get images() {
        return { ...images() };
      },
      start({ image, instance: type, env, labels }) {
        if (running) throw new Error("the container is already running");
        if (!image || !Object.values(images()).includes(image)) {
          throw new TypeError(`no image ${image || "(none)"} among the Worker's containers' images`);
        }
        if (!INSTANCE_TYPES.includes(type)) throw new TypeError(`no instance type ${type}`);
        const at = source(image);
        if (at === undefined) throw new Error("no container application runs behind this Durable Object");
        const runtime = start({ image: at, revision: labels.revision ?? "", env }).then((made) => {
          started.push(made);
          return made;
        });
        const mine = { runtime, image, labels: { ...labels }, port: Number(env.PORT) };
        running = mine;
        // A runtime that does not start leaves no container, as a failed start does.
        runtime.catch(() => {
          if (running === mine) running = undefined;
        });
      },
      inspect: async () => (running ? { image: running.image, labels: { ...running.labels } } : null),
      // A runtime that does not start is a container that ended; one that runs never does here.
      monitor: () => (running ? running.runtime.then(() => new Promise<void>(() => {})) : Promise.resolve()),
      destroy,
      getTcpPort: (port) => ({
        async fetch(input, init) {
          if (!running) throw new Error("the container is not running");
          if (port !== running.port) throw new Error(`nothing listens on port ${port} in the container`);
          const runtime = await running.runtime;
          const request = new Request(input, init);
          const { pathname, search } = new URL(request.url);
          const headers = new Headers(request.headers);
          for (const name of HOP) headers.delete(name);
          const answer = await fetch(new URL(pathname + search, runtime.url), {
            method: request.method,
            headers,
            body: request.body,
            redirect: "manual",
            signal: request.signal,
            ...(request.body && { duplex: "half" }),
          } as RequestInit);
          const back = new Headers(answer.headers);
          for (const name of HOP) back.delete(name);
          return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: back });
        },
      }),
      async setInactivityTimeout(ms) {
        inactivityMs = ms;
      },
    },
    storage: {
      get: async <T>(key: string) => structuredClone(storage.get(key)) as T | undefined,
      put: async (key, value) => void storage.set(key, structuredClone(value)),
      delete: async (key) => storage.delete(key),
      getAlarm: async () => alarm?.at ?? null,
      async setAlarm(at) {
        disarm();
        alarm = { at };
        schedule(alarm);
      },
      deleteAlarm: async () => disarm(),
    },
    blockConcurrencyWhile: (fn) => fn(),
  };

  return {
    ctx,
    /** The object made again from the Worker's code, as a deploy restarts it. */
    restart(made: Instance) {
      instance = made;
    },
    fetch: (request: Request) => active(() => instance!.fetch(request)),
    startNow: () => instance!.startNow(),
    /** Stops its container, as Cloudflare does once the object is quiet; its storage and alarm stay. */
    stop: destroy,
    /** Rings its alarm now, whatever its time; resolves once it rang. */
    async fire() {
      if (alarm) {
        clearTimeout(alarm.timer);
        ringing = ring(alarm).finally(() => (ringing = undefined));
      }
      await ringing;
    },
    /** Everything gone: its container, its alarm and its storage, as a deleted Worker's. */
    async remove() {
      disarm();
      storage.clear();
      await destroy();
    },
  };
}

type FakeObject = ReturnType<typeof fakeObject>;

/**
 * An in-memory Cloudflare account for tests, as the API answers: Workers in `state.scripts`,
 * container applications in `state.applications`, the images copied into its registry in
 * `state.images` (nothing is pulled), their custom domains in `state.domains` (every zone held
 * unless `zones` names them), each zone's DNS records in `state.dns`, by the zone's name (a batch
 * is all or nothing: an identical record or one beside a CNAME fails it whole), and the account's
 * workers.dev URLs served in
 * this process, one server on a port of this machine per Worker name (a name with no Worker
 * answers workers.dev's 404). Each Worker runs the package's own object code
 * (`worker/instance.js`) over a `ctx` in this process: its container runs `start`'s runtime
 * (the image and the revision label it was started at, the Worker's text bindings as its
 * environment), its storage is in memory, and its alarm rings on a timer, again after a throw.
 * An upload restarts the object over the new bindings and images, its container, storage and
 * alarm kept: a new image starts the container again at the next request, as the object finds its
 * label changed. `copyImage` pins its copy by a made-up digest, and `prepareImage` answers ready
 * for an image pinned in the account's registry. An assets upload session asks for the hashes
 * `state.assets` lacks, in one bucket, and an upload that redeems its completion jwt keeps each
 * path's hash on the Worker (`state.scripts[…].assets`); the Worker's requests still go to its
 * object, as the fake runs no sites bundle. `stop(name)` stops a company's
 * container as ten quiet minutes would, `fire()` rings every alarm now, `wakes()` lists the
 * `/wake`s the containers answered, `close()` (and `reset()`) stops everything.
 */
export function fakeCloudflare(options: FakeCloudflareOptions = {}) {
  const start = options.start ?? stubContainer;
  const servers = new Map<string, { server: Server; url: string }>();
  const objects = new Map<string, FakeObject>();
  /** Each Worker's env: its bindings' text, the secrets' with it, which the state does not keep. */
  const envs = new Map<string, Record<string, unknown>>();
  const started: FakeContainer[] = [];
  /** The open assets upload sessions, by jwt: the Worker's name, its manifest and the hashes still to upload. */
  const sessions = new Map<string, { script: string; manifest: Record<string, string>; missing: Set<string> }>();
  /** The completion jwts an upload may redeem: the Worker's name and its manifest, each path's hash. */
  const completed = new Map<string, { script: string; manifest: Record<string, string> }>();

  /** The request to the Worker named `script`, as workers.dev passes it on. */
  const dispatch = async (state: FakeCloudflareState, script: string, request: Request): Promise<Response> => {
    const env = envs.get(script);
    if (!env || !state.scripts[script]?.subdomain) return nothingHere();
    return worker.fetch(request, env);
  };
  const scriptAt = (url: string) => [...servers].find(([, s]) => s.url === new URL(url).origin)?.[0];

  /** The Worker name's URL: a server of its own, made at the first ask, which outlives the Worker as workers.dev's name does. */
  const serve = async (state: FakeCloudflareState, script: string) => {
    const found = servers.get(script);
    if (found) return found.url;
    const server = createServer((req, res) => {
      void dispatch(state, script, new NodeRequest({ req, res })).then(
        (answer) => sendNodeResponse(res, answer),
        (err: unknown) => {
          if (res.headersSent) return void res.destroy();
          res.writeHead(500, { "content-type": "text/plain" }).end(`${errorMessage(err)}\n`);
        },
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    // A fake no one closes, as a sandbox run's, keeps no process up.
    server.unref();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    servers.set(script, { server, url });
    return url;
  };

  const api = (state: FakeCloudflareState): CloudflareApi => {
    const appOf = (script: string) => Object.values(state.applications).find((a) => a.name === script);
    /** A new id, 32 digits, as Cloudflare's are 32 hexadecimal ones. */
    const nextId = () => String(++state.seq).padStart(32, "0");
    /** The name of the zone of that id among those looked up: a request names a zone by its id. */
    const zoneOf = (zoneId: string) => Object.entries(state.zones).find(([, id]) => id === zoneId)?.[0];
    const zoneNamed = (zoneId: string) => {
      const zone = zoneOf(zoneId);
      if (!zone)
        throw fail(
          404,
          7003,
          `zones/${zoneId}: Could not route to /zones/${zoneId}, perhaps your object identifier is invalid?`,
        );
      return zone;
    };
    const recordsOf = (zoneId: string) => state.dns[zoneNamed(zoneId)] ?? [];
    return {
      workerUrl: (script) => serve(state, script),
      async bindings(script) {
        return structuredClone(state.scripts[script]?.bindings);
      },
      async upload(script, { modules, main_module, bindings, containers, migrations, assets }) {
        if (!modules.some((m) => m.name === main_module)) throw fail(400, 10021, `no module named ${main_module}`);
        const redeemed = assets && completed.get(assets.jwt);
        if (assets && redeemed?.script !== script) {
          throw fail(400, 10203, "the assets' completion jwt is not one this Worker's upload session gave");
        }
        if (bindings.some((b) => b.type === "assets") !== Boolean(assets)) {
          throw fail(400, 10021, "an assets binding needs assets, and assets an assets binding");
        }
        const runs = containers.find((c) => c.class_name === OBJECT_CLASS);
        if (!runs) throw fail(400, 10021, `${OBJECT_CLASS} is no container's: its object would have no ctx.container`);
        const unpinned = Object.values(runs.images).filter((image) => !accountPinned(image, FAKE_ACCOUNT));
        if (!Object.keys(runs.images).length || unpinned.length) {
          throw fail(400, 10021, `an image must be the account's, pinned by digest: ${unpinned.join(", ") || "none"}`);
        }
        const known = state.scripts[script] !== undefined;
        if (!known && !migrations?.new_sqlite_classes.includes(OBJECT_CLASS)) {
          throw fail(400, 10061, `Cannot create binding for class ${OBJECT_CLASS}: it is not a Durable Object yet`);
        }
        const env: Record<string, unknown> = {};
        for (const binding of bindings) {
          if (binding.type === "durable_object_namespace") {
            env[binding.name] = {
              getByName: () => ({
                fetch: (request: Request) => objects.get(script)!.fetch(request),
                startNow: () => objects.get(script)!.startNow(),
              }),
            };
          } else if (binding.type !== "assets") env[binding.name] = binding.text;
        }
        envs.set(script, env);
        // The namespace the first upload made, kept across uploads as Cloudflare keeps it.
        const namespace_id = state.scripts[script]?.bindings.find((b) => b.namespace_id)?.namespace_id ?? nextId();
        state.scripts[script] = {
          bindings: bindings.map(({ type, name, ...rest }) =>
            type === "secret_text"
              ? { type, name }
              : type === "durable_object_namespace"
                ? { type, name, namespace_id }
                : { type, name, ...("text" in rest && { text: rest.text }) },
          ),
          subdomain: state.scripts[script]?.subdomain ?? false,
          images: { ...runs.images },
          main_module,
          modules: modules.map((m) => m.name),
          ...(redeemed && { assets: { ...redeemed.manifest } }),
        };
        if (assets) completed.delete(assets.jwt);
        const object =
          objects.get(script) ??
          fakeObject(
            start,
            () => state.scripts[script]?.images ?? {},
            (image) => appOf(script) && (state.images[image] ?? image),
            started,
          );
        objects.set(script, object);
        object.restart(new Instance(object.ctx, env));
      },
      async enableSubdomain(script) {
        const found = state.scripts[script];
        if (!found) throw fail(404, 10007, `workers/scripts/${script}: This Worker does not exist on your account.`);
        found.subdomain = true;
      },
      async deleteScript(script) {
        delete state.scripts[script];
        envs.delete(script);
        await objects.get(script)?.remove();
        objects.delete(script);
      },
      async application(name) {
        const found = appOf(name);
        return found && { id: found.id };
      },
      async createApplication(name, namespaceId) {
        const namespace = state.scripts[name]?.bindings.find((b) => b.namespace_id)?.namespace_id;
        if (!namespace || namespace !== namespaceId)
          throw fail(400, 1000, `no Durable Object namespace ${namespaceId}`);
        if (appOf(name)) throw fail(409, 1001, `an application named ${name} exists`);
        const id = `00000000-0000-4000-8000-${String(++state.seq).padStart(12, "0")}`;
        state.applications[id] = { id, name };
        return { id };
      },
      account: FAKE_ACCOUNT,
      async copyImage(image) {
        const digest = `sha256:${createHash("sha256").update(image).digest("hex")}`;
        const pinned = pinImage(accountImage(image, FAKE_ACCOUNT), digest);
        state.images[pinned] = image;
        return pinned;
      },
      async prepareImage(image) {
        if (!accountPinned(image, FAKE_ACCOUNT)) {
          throw fail(400, 1000, `${image}: an image must be the account's, pinned by digest`);
        }
        return { status: "ready" };
      },
      async deleteApplication(id) {
        const found = state.applications[id];
        delete state.applications[id];
        if (found) await objects.get(found.name)?.stop();
      },
      async zone(name) {
        if (options.zones && !options.zones.includes(name)) return undefined;
        state.zones[name] ??= nextId();
        return state.zones[name];
      },
      async domains(script) {
        return Object.entries(state.domains)
          .filter(([, d]) => d.service === script)
          .map(([id, { hostname }]) => ({ id, hostname }));
      },
      async attachDomain(script, hostname, zone_id) {
        if (!state.scripts[script])
          throw fail(404, 10007, `workers/domains: This Worker does not exist on your account.`);
        const zone = zoneOf(zone_id);
        if (!zone || !inZone(hostname, zone)) {
          throw fail(400, 100117, `workers/domains: ${hostname} is not in the zone ${zone_id}`);
        }
        const id = Object.entries(state.domains).find(([, d]) => d.hostname === hostname)?.[0] ?? nextId();
        state.domains[id] = { hostname, service: script, zone_id };
      },
      async detachDomain(id) {
        delete state.domains[id];
      },
      async dnsRecords(zoneId, comment) {
        // `comment.exact` ignores case, as Cloudflare's does.
        const exact = comment.toLowerCase();
        return structuredClone(recordsOf(zoneId).filter((r) => r.comment?.toLowerCase() === exact));
      },
      async dnsRecordsAt(zoneId, name) {
        return structuredClone(recordsOf(zoneId).filter((r) => r.name === name));
      },
      async writeDns(zoneId, { posts, patches, deletes }) {
        const zone = zoneNamed(zoneId);
        // On a copy, kept only once every change is made: a batch is one transaction.
        const held = structuredClone(state.dns[zone] ?? []);
        const at = (id: string) => {
          const found = held.findIndex((r) => r.id === id);
          if (found < 0) throw fail(404, 81044, `dns_records/batch: Record ${id} does not exist.`);
          return found;
        };
        for (const { id } of deletes) held.splice(at(id), 1);
        const patched = patches.map(({ id, ...write }) => {
          const record = { id, ...dnsRecordOf(zone, write) };
          held[at(id)] = record;
          return record;
        });
        const posted = posts.map((write) => {
          const record = { id: nextId(), ...dnsRecordOf(zone, write) };
          held.push(record);
          return record;
        });
        for (const record of [...patched, ...posted]) {
          const beside = held.filter((r) => r.id !== record.id && r.name === record.name);
          if (
            beside.some((r) => r.type === record.type && r.content === record.content && r.priority === record.priority)
          ) {
            throw fail(400, 81058, "dns_records/batch: An identical record already exists.");
          }
          if (beside.some((r) => r.type === "CNAME" || record.type === "CNAME")) {
            throw fail(400, 81053, "dns_records/batch: An A, AAAA, or CNAME record with that host already exists.");
          }
        }
        state.dns[zone] = held;
        return structuredClone({ patches: patched, posts: posted });
      },
      async assetsSession(script, manifest) {
        const jwt = `session-${++state.seq}`;
        const hashes = Object.fromEntries(Object.entries(manifest).map(([path, { hash }]) => [path, hash]));
        const missing = new Set(Object.values(hashes).filter((hash) => !(hash in state.assets)));
        if (!missing.size) {
          completed.set(jwt, { script, manifest: hashes });
          return { jwt, buckets: [] };
        }
        sessions.set(jwt, { script, manifest: hashes, missing });
        return { jwt, buckets: [[...missing]] };
      },
      async uploadAssets(jwt, files) {
        const session = sessions.get(jwt);
        if (!session) throw fail(401, 10000, "workers/assets/upload: the jwt is no open upload session's");
        for (const { hash, contentType } of files) {
          if (!session.missing.delete(hash)) throw fail(400, 10203, `workers/assets/upload: ${hash} is not asked for`);
          state.assets[hash] = contentType;
        }
        if (session.missing.size) return undefined;
        sessions.delete(jwt);
        const completion = `completion-${++state.seq}`;
        completed.set(completion, { script: session.script, manifest: session.manifest });
        return completion;
      },
      async send(url, init) {
        const script = scriptAt(url);
        if (!script) throw new TypeError(`fetch failed: nothing answers at ${new URL(url).origin}`);
        return dispatch(state, script, new Request(url, init));
      },
    };
  };

  const fake = defineFake(
    cloudflareOps,
    {
      initial: (): FakeCloudflareState => ({
        seq: 0,
        scripts: {},
        assets: {},
        applications: {},
        images: {},
        zones: {},
        domains: {},
        dns: {},
      }),
      ops: (state) => ({
        container: containerOps(() => api(state), { startTimeoutMs: 60_000, pollMs: 50 }),
        alarm: alarmOps(() => api(state)),
        records: recordsOps(() => api(state)),
      }),
    },
    options,
  );
  const named = (name?: string) =>
    [...objects].filter(([script]) => name === undefined || script === scriptOf(name)).map(([, o]) => o);
  const close = async () => {
    for (const object of objects.values()) await object.remove();
    objects.clear();
    envs.clear();
    sessions.clear();
    completed.clear();
    for (const { server } of servers.values()) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
    servers.clear();
  };
  const { reset } = fake;
  return Object.assign(fake, {
    /** Stops the container of the company `name` (default: every one), as ten quiet minutes would: the next request starts it. */
    async stop(name?: string) {
      for (const object of named(name)) await object.stop();
    },
    /** Rings every armed alarm now, whatever its time; resolves once each rang. */
    async fire() {
      await Promise.all(named().map((object) => object.fire()));
    },
    /** Each `/wake` the containers answered, in order of their starts. */
    wakes: (): FakeWake[] => started.flatMap((c) => c.wakes ?? []),
    /** Stops every container and alarm, and every Worker's server. */
    close,
    /** Empties the state and stops everything. */
    async reset() {
      await close();
      reset();
    },
  });
}
