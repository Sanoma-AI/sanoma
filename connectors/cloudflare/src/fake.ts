import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AppBundle, AppBundleModule } from "@sanoma-ai/app";
import { DriverError, errorMessage, retryableStatus } from "@sanoma-ai/workflows";
import { defineFake, type FakeOptions } from "@sanoma-ai/workflows/fake";
import { APP_BUNDLE_HEADER, APP_BUNDLE_PATH } from "@sanoma-ai/workflows/shared";
import { NodeRequest, sendNodeResponse } from "srvx/node";
import { Instance, type ObjectState, serve } from "../worker/instance.js";
import { caaContent, cloudflareOps, host } from "./connector.ts";
import { OBJECT_CLASS, type WorkerModule } from "./deploy.ts";
import {
  alarmOps,
  type Application,
  type CloudflareApi,
  containerOps,
  type HyperdriveOrigin,
  inZone,
  originOf,
  type ReadBinding,
  type RecordWrite,
  scriptOf,
  type ZoneRecord,
} from "./ops.ts";
import { recordsOps } from "./records.ts";
import { accountImage, accountPinned, pinImage } from "./registry.ts";

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
  /**
   * The app bundle a container's worker builds at a revision, which its port's
   * `/__sanoma/app-bundle` answers (202 on the first ask, as the runtime's route does). Default:
   * `stubAppBundle`.
   */
  bundle?: (revision: string) => AppBundle;
  /** The zones the account holds, by name. Default: every one asked for, as a sandbox's account holds its domains. */
  zones?: readonly string[];
  /**
   * How many requests to a Worker the version before an upload still answers once it is made (none
   * for a new Worker: workers.dev's 404), as an upload takes a while to reach every location.
   * Default 0: the next request runs it.
   */
  propagation?: number;
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
      compatibility_date?: string;
      compatibility_flags?: string[];
      assets?: Record<string, string>;
      /** The latest version's tag (`annotations["workers/tag"]`). */
      tag?: string;
    }
  >;
  /** The account's Hyperdrive configs, by id: each one's name and its origin, its password left out. */
  hyperdrives: Record<string, { name: string; origin: Omit<HyperdriveOrigin, "password"> }>;
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

/** A Hyperdrive config's origin as a database URL: what the fake's `DATABASE` binding gives. */
const connectionString = ({ scheme, user, password, host: at, port, database }: HyperdriveOrigin) =>
  `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${at}:${port}/${encodeURIComponent(database)}`;

/** workers.dev's answer for a name with no Worker behind it. */
const nothingHere = () =>
  new Response("<!doctype html><title>There is nothing here yet</title>", {
    status: 404,
    headers: { "content-type": "text/html" },
  });

/** A runtime that answers `/healthz` and records each `/wake`: what a container runs unless the fake is given `start`. */
export const stubContainer: StartContainer = async () => {
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

const b64 = (text: string) => Buffer.from(text).toString("base64");

/**
 * The app bundle the fake's containers build unless it is given `bundle`: one main module and one
 * asset. Its fetch answers `/healthz`, an asset from `ASSETS`, a POST by having the host start the
 * worker (as a page that queues a run does), and any other page with the revision it was built at
 * (`x-sanoma-revision`) and the visitor's address it was given (`x-sanoma-client-ip`); a 500
 * without its `DATABASE` binding, or while its database lacks the revision's migrations, which a
 * worker at the revision makes at its start (`DATABASE.prepared`), as the app on the Worker never
 * migrates (`checkPreparedOnly`) and refuses a database behind it. Not the app's own bundle: that
 * one is a build for `workerd` (`nodejs_compat`, its wasm modules), which Node cannot import.
 */
export function stubAppBundle(revision: string): AppBundle {
  const main = `const REVISION = ${JSON.stringify(revision)};
export default {
  async fetch(request, env, ctx, host) {
    if (typeof env.DATABASE?.connectionString !== "string") return new Response("no DATABASE binding\\n", { status: 500 });
    if (!env.DATABASE.prepared(REVISION)) return new Response("the database has no Sanoma's tables yet\\n", { status: 500 });
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok\\n");
    if (url.pathname.startsWith("/assets/")) return env.ASSETS.fetch(request);
    if (request.method === "POST") {
      ctx.waitUntil(host.startNow());
      return new Response(null, { status: 202 });
    }
    return new Response(\`<!doctype html><title>\${REVISION}</title>\\n\`, {
      headers: {
        "content-type": "text/html",
        "x-sanoma-revision": REVISION,
        "x-sanoma-client-ip": request.headers.get("x-sanoma-client-ip") ?? "",
      },
    });
  },
};
`;
  const asset = b64("console.log('sanoma');\n");
  return {
    version: revision,
    mainModule: "index.js",
    modules: [{ name: "index.js", type: "esm", content: b64(main) }],
    assets: [
      {
        path: "/assets/app.js",
        content: asset,
        hash: createHash("sha256").update(`${asset}js`).digest("hex").slice(0, 32),
        size: Buffer.byteLength(asset, "base64"),
      },
    ],
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    prerendered: [],
  };
}

/** An answer of the runtime's app-bundle route, marked as the route's. */
const bundleAnswer = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { [APP_BUNDLE_HEADER]: "1" } });

/**
 * One Durable Object of a Worker, in this process: the `ctx` `worker/instance.js` runs over
 * (`ctx.container` running `start`'s runtime, `ctx.storage` in memory, one alarm on a timer),
 * kept across uploads as Cloudflare keeps an object's storage and container across a deploy.
 * `images` are the ones the Worker's last upload named, by name; `source` names the image a
 * pinned one was copied from, or nothing when no application runs behind the object.
 */
function fakeObject(
  start: StartContainer,
  bundle: (revision: string) => AppBundle,
  images: () => Record<string, string>,
  source: (image: string) => string | undefined,
  started: FakeContainer[],
) {
  const storage = new Map<string, unknown>();
  let running:
    | {
        runtime: Promise<FakeContainer>;
        image: string;
        labels: Record<string, string>;
        port: number;
        token?: string;
        /** The revisions its worker was asked the app bundle of: the first ask builds it. */
        built: Set<string>;
      }
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
  /** The runtime's own `/__sanoma/app-bundle`, as the worker port answers it (`appBundleRoute`). */
  const bundleRoute = (request: Request, mine: NonNullable<typeof running>) => {
    const token = mine.token;
    if (!token || request.headers.get("authorization") !== `Bearer ${token}`) {
      return bundleAnswer(401, { error: "the token is not this instance's SANOMA_WAKEUP_TOKEN" });
    }
    const revision = new URL(request.url).searchParams.get("revision") ?? "";
    if (!revision) return bundleAnswer(400, { error: "revision must be a commit id (?revision=<sha>)" });
    if (!mine.built.has(revision)) {
      mine.built.add(revision);
      return bundleAnswer(202, { building: revision });
    }
    return bundleAnswer(200, bundle(revision));
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
        const mine = {
          runtime,
          image,
          labels: { ...labels },
          port: Number(env.PORT),
          ...(env.SANOMA_WAKEUP_TOKEN && { token: env.SANOMA_WAKEUP_TOKEN }),
          built: new Set<string>(),
        };
        running = mine;
        // A runtime that does not start leaves no container, as a failed start does.
        runtime.catch(() => {
          if (running === mine) running = undefined;
        });
      },
      inspect: async () => (running ? { image: running.image, labels: { ...running.labels } } : null),
      // A runtime that does not start is a container that ended; one that runs never does here.
      monitor: () => (running ? running.runtime.then(() => new Promise<void>(() => {})) : Promise.resolve()),
      // The worker's own stop: it drains and exits, and the container with it.
      signal(signal) {
        if (signal !== 15) throw new TypeError(`the fake sends SIGTERM (15) alone, not ${signal}`);
        const was = running;
        if (!was) return;
        void was.runtime
          .then((runtime) => runtime.stop())
          .catch(() => undefined)
          .finally(() => {
            if (running === was) running = undefined;
          });
      },
      destroy,
      getTcpPort: (port) => ({
        async fetch(input, init) {
          if (!running) throw new Error("the container is not running");
          if (port !== running.port) throw new Error(`nothing listens on port ${port} in the container`);
          const mine = running;
          const runtime = await mine.runtime;
          const request = new Request(input, init);
          const { pathname, search } = new URL(request.url);
          if (pathname === APP_BUNDLE_PATH) return bundleRoute(request, mine);
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

/** One version of a Worker, as it runs in this process (`fakeCloudflare`'s `workers`). */
interface FakeVersion {
  env: Record<string, unknown>;
  loadApp: () => Promise<{ default: AppBundleModule }>;
  images: Record<string, string>;
  assets?: Record<string, string>;
  modules: WorkerModule[];
}

/**
 * An in-memory Cloudflare account for tests, as the API answers: Workers in `state.scripts`,
 * container applications in `state.applications`, Hyperdrive configs in `state.hyperdrives`
 * (their passwords left out), the images copied into its registry in `state.images` (nothing is
 * pulled), their custom domains in `state.domains` (every zone held unless `zones` names them),
 * each zone's DNS records in `state.dns`, by the zone's name (a batch is all or nothing: an
 * identical record or one beside a CNAME fails it whole), and the account's workers.dev URLs
 * served in this process, one server on a port of this machine per Worker name (a name with no
 * Worker answers workers.dev's 404).
 *
 * Each Worker runs the package's own code (`worker/instance.js`): its fetch (`serve`) over the
 * upload's `app/index.js`, written to a folder and imported (the placeholder of a create's first
 * uploads, then the bundle's main module, `stubAppBundle` unless `bundle` says), its `DATABASE`
 * the config's direct URL (and `prepared(revision)`: whether a container's worker at that
 * revision started over it, as each prepares its database at its start), its `ASSETS` the
 * uploaded contents; and its object over a `ctx` in this
 * process: its container runs `start`'s runtime (the image and the revision label it was started
 * at, the Worker's text bindings as its environment), its port's `/__sanoma/app-bundle` answers
 * `bundle`'s as the runtime's route does, SIGTERM stops the runtime, its storage is in memory, and
 * its alarm rings on a timer, again after a throw. An upload answers once `propagation` more
 * requests went to the version before (none: at once), and then restarts the object over the new
 * bindings and images, its container, storage and alarm kept: the object finds the labels changed
 * at the next start, and drains and replaces it. `settings` and `content` give the latest upload
 * back, its tag and its modules, and an upload that keeps its assets (`keep_assets`) serves the
 * version before's. `copyImage` pins its copy by a made-up digest,
 * and `prepareImage` answers ready for an image pinned in the account's registry. An assets upload
 * session asks for the hashes `state.assets` lacks, in one bucket, and an upload that redeems its
 * completion jwt keeps each path's hash on the Worker (`state.scripts[…].assets`). `stop(name)`
 * stops a company's container as ten quiet minutes would, `fire()` rings every alarm now,
 * `wakes()` lists the `/wake`s the containers answered, `close()` (and `reset()`) stops everything.
 */
export function fakeCloudflare(options: FakeCloudflareOptions = {}) {
  const start = options.start ?? stubContainer;
  const bundle = options.bundle ?? stubAppBundle;
  const servers = new Map<string, { server: Server; url: string }>();
  const objects = new Map<string, FakeObject>();
  /**
   * Each Worker's versions: the one that answers (`live`), and the latest upload until it does
   * (`next`, after `after` more requests). A version as it runs: its env (its bindings' text, the
   * secrets' with it, which the state does not keep, its database, assets and object), its app,
   * the upload's `app/index.js` imported from a folder of its own on the first request, the images
   * its object may start, its assets (each path's hash) and its modules, as its content gives them.
   */
  const workers = new Map<string, { live?: FakeVersion; next?: FakeVersion; after: number }>();
  /** Where each upload's modules are written, to be imported as files. */
  let uploads: string | undefined;
  /** Each Hyperdrive config's database URL, which the state does not keep: its password is in it. */
  const databases = new Map<string, string>();
  /** The assets' contents, by hash, which the state does not keep. */
  const contents = new Map<string, { content: Buffer; contentType: string }>();
  /**
   * The revisions whose worker prepared each database, by its URL as a Hyperdrive config gives it:
   * a container's worker makes its revision's migrations at its start, before its port answers,
   * and a database keeps every migration made (a newer one serves an older app).
   */
  const preparedAt = new Map<string, Set<string>>();
  const started: FakeContainer[] = [];
  /** `start`, its worker having prepared its database (`SANOMA_DATABASE_URL`, a host's) at its revision once it runs. */
  const preparing: StartContainer = async (input) => {
    const made = await start(input);
    const url = input.env.SANOMA_DATABASE_URL;
    if (url) {
      const database = connectionString(originOf("", url));
      preparedAt.set(database, (preparedAt.get(database) ?? new Set()).add(input.revision));
    }
    return made;
  };
  /** The open assets upload sessions, by jwt: the Worker's name, its manifest and the hashes still to upload. */
  const sessions = new Map<string, { script: string; manifest: Record<string, string>; missing: Set<string> }>();
  /** The completion jwts an upload may redeem: the Worker's name and its manifest, each path's hash. */
  const completed = new Map<string, { script: string; manifest: Record<string, string> }>();

  /** The asset at the request's path among `assets` (each path's hash), if it is one. */
  const assetOf = (assets: Record<string, string> | undefined, request: Request) => {
    const hash = assets?.[new URL(request.url).pathname];
    const found = hash === undefined ? undefined : contents.get(hash);
    return found && new Response(found.content, { headers: { "content-type": found.contentType } });
  };
  /** Makes the Worker's latest upload the version that answers: its object made again over its env, as a deploy restarts it. */
  const promote = (script: string, versions: { live?: FakeVersion; next?: FakeVersion }) => {
    const object = objects.get(script)!;
    versions.live = versions.next;
    versions.next = undefined;
    object.restart(new Instance(object.ctx, versions.live!.env));
  };
  /** The version that answers the Worker's next request: its latest upload's once that has waited its requests out. */
  const answering = (script: string) => {
    const versions = workers.get(script);
    if (versions?.next && versions.after-- <= 0) promote(script, versions);
    return versions?.live;
  };
  /**
   * The request to the Worker named `script`, as workers.dev passes it on: a path under
   * `/assets/` its assets have straight from them (`run_worker_first`), anything else to the
   * Worker script's fetch (`serve`, the package's own) over its last upload, with Cloudflare's
   * `cf-connecting-ip` set from the visitor's address.
   */
  const dispatch = async (
    state: FakeCloudflareState,
    script: string,
    request: Request,
    visitor = "127.0.0.1",
  ): Promise<Response> => {
    const worker = answering(script);
    if (!worker || !state.scripts[script]?.subdomain) return nothingHere();
    if (new URL(request.url).pathname.startsWith("/assets/")) {
      const asset = assetOf(worker.assets, request);
      if (asset) return asset;
    }
    const headers = new Headers(request.headers);
    headers.set("cf-connecting-ip", visitor);
    const ctx = {
      waitUntil: (promise: Promise<unknown>) =>
        void promise.catch((err: unknown) => console.warn(`cloudflare fake: a waitUntil threw: ${errorMessage(err)}`)),
    };
    return serve(new Request(request, { headers }), worker.env, ctx, worker.loadApp);
  };
  /** Writes an upload's modules to a folder of their own: the app is imported from there. */
  const written = (modules: { name: string; content: string | Uint8Array }[]) => {
    uploads ??= mkdtempSync(join(tmpdir(), "sanoma-cloudflare-fake-"));
    const dir = mkdtempSync(join(uploads, "upload-"));
    for (const { name, content } of modules.filter((m) => m.name.startsWith("app/"))) {
      const file = join(dir, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    let app: Promise<{ default: AppBundleModule }> | undefined;
    return () =>
      (app ??= import(pathToFileURL(join(dir, "app", "index.js")).href) as Promise<{ default: AppBundleModule }>);
  };
  /** A Hyperdrive config written: its origin in the state without the password, its URL beside it. */
  const keep = (state: FakeCloudflareState, id: string, name: string, origin: HyperdriveOrigin) => {
    const { password: _password, ...shown } = origin;
    (state.hyperdrives ??= {})[id] = { name, origin: shown };
    databases.set(id, connectionString(origin));
  };
  const scriptAt = (url: string) => [...servers].find(([, s]) => s.url === new URL(url).origin)?.[0];

  /** The Worker name's URL: a server of its own, made at the first ask, which outlives the Worker as workers.dev's name does. */
  const listenAt = async (state: FakeCloudflareState, script: string) => {
    const found = servers.get(script);
    if (found) return found.url;
    const server = createServer((req, res) => {
      // Made from its parts: undici's Request cannot copy the server's own request.
      const { method, url, headers, body } = new NodeRequest({ req, res });
      const request = new Request(url, { method, headers, body, duplex: "half" } as RequestInit);
      void dispatch(state, script, request, req.socket.remoteAddress).then(
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
      workerUrl: (script) => listenAt(state, script),
      async settings(script) {
        const found = state.scripts[script];
        return (
          found && {
            bindings: structuredClone(found.bindings),
            compatibility_date: found.compatibility_date,
            compatibility_flags: [...(found.compatibility_flags ?? [])],
            ...(found.tag !== undefined && { annotations: { "workers/tag": found.tag } }),
          }
        );
      },
      async content(script) {
        const versions = workers.get(script);
        const latest = versions?.next ?? versions?.live;
        if (!latest) throw fail(404, 10007, `workers/scripts/${script}: This Worker does not exist on your account.`);
        return structuredClone(latest.modules);
      },
      async upload(
        script,
        {
          modules,
          main_module,
          bindings,
          containers,
          migrations,
          assets,
          keep_assets,
          annotations,
          compatibility_date,
          compatibility_flags,
        },
      ) {
        if (!modules.some((m) => m.name === main_module)) throw fail(400, 10021, `no module named ${main_module}`);
        if (!modules.some((m) => m.name === "app/index.js")) throw fail(400, 10021, "no module named app/index.js");
        const redeemed = assets?.jwt === undefined ? undefined : completed.get(assets.jwt);
        if (assets?.jwt !== undefined && redeemed?.script !== script) {
          throw fail(400, 10203, "the assets' completion jwt is not one this Worker's upload session gave");
        }
        // The assets redeemed, else with `keep_assets` the version before's.
        const manifest = redeemed?.manifest ?? (keep_assets ? state.scripts[script]?.assets : undefined);
        if (bindings.some((b) => b.type === "assets") !== Boolean(manifest)) {
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
        // The version's id, as Cloudflare answers an upload and the version's metadata binding names it.
        const version = `00000000-0000-4000-9000-${String(++state.seq).padStart(12, "0")}`;
        const env: Record<string, unknown> = {};
        for (const binding of bindings) {
          if (binding.type === "durable_object_namespace") {
            env[binding.name] = {
              getByName: () => ({
                fetch: (request: Request) => objects.get(script)!.fetch(request),
                startNow: () => objects.get(script)!.startNow(),
              }),
            };
          } else if (binding.type === "hyperdrive") {
            const url = databases.get(binding.id);
            if (url === undefined) throw fail(400, 10021, `no Hyperdrive config ${binding.id}`);
            // The direct URL: Hyperdrive's pooled one is Cloudflare's own. With the fake's own
            // `prepared`: whether a worker at a revision made its migrations there, which the app reads.
            env[binding.name] = {
              connectionString: url,
              prepared: (revision: string) => preparedAt.get(url)?.has(revision) ?? false,
            };
          } else if (binding.type === "version_metadata") {
            env[binding.name] = { id: version, tag: annotations?.["workers/tag"] ?? "", timestamp: "" };
          } else if (binding.type === "assets") {
            env[binding.name] = {
              fetch: async (request: Request) => assetOf(manifest, request) ?? new Response(null, { status: 404 }),
            };
          } else env[binding.name] = binding.text;
        }
        // The namespace the first upload made, kept across uploads as Cloudflare keeps it.
        const namespace_id = state.scripts[script]?.bindings.find((b) => b.namespace_id)?.namespace_id ?? nextId();
        state.scripts[script] = {
          bindings: bindings.map(({ type, name, ...rest }) =>
            type === "secret_text"
              ? { type, name }
              : type === "durable_object_namespace"
                ? { type, name, namespace_id }
                : { type, name, ...("text" in rest && { text: rest.text }), ...("id" in rest && { id: rest.id }) },
          ),
          subdomain: state.scripts[script]?.subdomain ?? false,
          images: { ...runs.images },
          main_module,
          modules: modules.map((m) => m.name),
          compatibility_date,
          ...(compatibility_flags.length > 0 && { compatibility_flags: [...compatibility_flags] }),
          ...(manifest && { assets: { ...manifest } }),
          ...(annotations && { tag: annotations["workers/tag"] }),
        };
        if (redeemed) completed.delete(assets!.jwt!);
        if (!objects.has(script)) {
          objects.set(
            script,
            fakeObject(
              preparing,
              bundle,
              () => workers.get(script)?.live?.images ?? {},
              (image) => appOf(script) && (state.images[image] ?? image),
              started,
            ),
          );
        }
        const versions = workers.get(script) ?? { after: 0 };
        versions.next = {
          env,
          loadApp: written(modules),
          images: { ...runs.images },
          ...(manifest && { assets: { ...manifest } }),
          modules: structuredClone(modules),
        };
        versions.after = options.propagation ?? 0;
        workers.set(script, versions);
        if (!versions.after) promote(script, versions);
        return version;
      },
      async enableSubdomain(script) {
        const found = state.scripts[script];
        if (!found) throw fail(404, 10007, `workers/scripts/${script}: This Worker does not exist on your account.`);
        found.subdomain = true;
      },
      async hyperdrive(name) {
        const id = Object.entries(state.hyperdrives ?? {}).find(([, config]) => config.name === name)?.[0];
        return id === undefined ? undefined : { id };
      },
      async createHyperdrive(name, origin) {
        if (Object.values((state.hyperdrives ??= {})).some((config) => config.name === name)) {
          throw fail(409, 2017, `hyperdrive/configs: a configuration named ${name} exists`);
        }
        const id = nextId();
        keep(state, id, name, origin);
        return { id };
      },
      async updateHyperdrive(id, name, origin) {
        if (!state.hyperdrives?.[id]) throw fail(404, 2005, `hyperdrive/configs/${id}: not found`);
        keep(state, id, name, origin);
      },
      async deleteHyperdrive(id) {
        delete state.hyperdrives?.[id];
        databases.delete(id);
      },
      async deleteScript(script) {
        delete state.scripts[script];
        workers.delete(script);
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
        // A state saved before the fake kept assets has none.
        state.assets ??= {};
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
        for (const { hash, base64, contentType } of files) {
          if (!session.missing.delete(hash)) throw fail(400, 10203, `workers/assets/upload: ${hash} is not asked for`);
          (state.assets ??= {})[hash] = contentType;
          contents.set(hash, { content: Buffer.from(base64, "base64"), contentType });
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
        hyperdrives: {},
        applications: {},
        images: {},
        zones: {},
        domains: {},
        dns: {},
      }),
      ops: (state) => ({
        host: containerOps(() => api(state), { startTimeoutMs: 60_000, pollMs: 50 }, host),
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
    workers.clear();
    databases.clear();
    contents.clear();
    if (uploads) rmSync(uploads, { recursive: true, force: true });
    uploads = undefined;
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
