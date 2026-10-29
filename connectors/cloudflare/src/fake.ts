import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DriverError, errorMessage, retryableStatus } from "@sanoma-ai/workflows";
import { defineFake, type FakeOptions } from "@sanoma-ai/workflows/fake";
import { NodeRequest, sendNodeResponse } from "srvx/node";
import { cloudflareOps } from "./connector.ts";
import { alarmOps, type Application, type CloudflareApi, containerOps, type ReadBinding, scriptOf } from "./ops.ts";
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
}

export interface FakeCloudflareState extends Record<string, unknown> {
  seq: number;
  /** The Workers, by script name: their bindings, a secret's without its text, and the images their object may start, by name. */
  scripts: Record<string, { bindings: ReadBinding[]; subdomain: boolean; images: Record<string, string> }>;
  /** The container applications, by id. */
  applications: Record<string, Application & { name: string }>;
  /** The account's registry: each image copied in, by its pinned reference there, and the image it was copied from. */
  images: Record<string, string>;
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
 * `state.images` (nothing is pulled), and the account's workers.dev URLs served in
 * this process, one server on a port of this machine per Worker name (a name with no Worker
 * answers workers.dev's 404). Each Worker runs the package's own object code
 * (`worker/instance.js`) over a `ctx` in this process: its container runs `start`'s runtime
 * (the image and the revision label it was started at, the Worker's text bindings as its
 * environment), its storage is in memory, and its alarm rings on a timer, again after a throw.
 * An upload restarts the object over the new bindings and images, its container, storage and
 * alarm kept: a new image starts the container again at the next request, as the object finds its
 * label changed. `copyImage` pins its copy by a made-up digest, and `prepareImage` answers ready
 * for an image pinned in the account's registry. `stop(name)` stops a company's
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
    return {
      workerUrl: (script) => serve(state, script),
      async bindings(script) {
        return structuredClone(state.scripts[script]?.bindings);
      },
      async upload(script, { modules, main_module, bindings, containers, migrations }) {
        if (!modules.some((m) => m.name === main_module)) throw fail(400, 10021, `no module named ${main_module}`);
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
              getByName: () => ({ fetch: (request: Request) => objects.get(script)!.fetch(request) }),
            };
          } else env[binding.name] = binding.text;
        }
        envs.set(script, env);
        // The namespace the first upload made, kept across uploads as Cloudflare keeps it.
        const namespace_id =
          state.scripts[script]?.bindings.find((b) => b.namespace_id)?.namespace_id ??
          `${String(++state.seq).padStart(32, "0")}`;
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
        };
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
        return found && { id: found.id, policy: found.policy };
      },
      async createApplication(name, namespaceId) {
        const namespace = state.scripts[name]?.bindings.find((b) => b.namespace_id)?.namespace_id;
        if (!namespace || namespace !== namespaceId)
          throw fail(400, 1000, `no Durable Object namespace ${namespaceId}`);
        if (appOf(name)) throw fail(409, 1001, `an application named ${name} exists`);
        const id = `00000000-0000-4000-8000-${String(++state.seq).padStart(12, "0")}`;
        state.applications[id] = { id, name, policy: "durable_object" };
        return { id, policy: "durable_object" };
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
      initial: (): FakeCloudflareState => ({ seq: 0, scripts: {}, applications: {}, images: {} }),
      ops: (state) => ({
        container: containerOps(() => api(state), { startTimeoutMs: 60_000, pollMs: 50 }),
        alarm: alarmOps(() => api(state)),
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
