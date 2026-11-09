import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLIENT_IP_HEADER as RUNTIME_CLIENT_IP_HEADER, WAKE_PATH as RUNTIME_WAKE_PATH } from "sanoma/workflows";
import { APP_BUNDLE_PATH as RUNTIME_APP_BUNDLE_PATH } from "sanoma/workflows/shared";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  APP_BUNDLE_PATH,
  CLIENT_IP_HEADER,
  DEPLOYMENT_HEADER,
  digestLabel,
  Instance,
  INACTIVITY_MS,
  type ObjectState,
  serve,
  WAKE_PATH,
} from "../worker/instance.js";

// The Worker's own code, `worker/instance.js`, over a stubbed `ctx`: the Worker script's fetch
// (`serve`), the routes of its object, the start, drain and replacement of its container, and the
// alarm. The kits run it over the fake's `ctx` (`host.test.ts`, `wakeup.test.ts`); `index.js`,
// which only binds it to `DurableObject` and the uploaded app, runs on Cloudflare (Miniflare would
// run it here, which this package does not add).

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const TOKEN = "swi_the-company-token";
const ENV = {
  SANOMA_INSTANCE: { not: "a string" },
  SANOMA_REVISION: "r2",
  SANOMA_IMAGE: "ghcr.io/sanoma-ai/runtime:0.7.0",
  SANOMA_SOURCE: "https://github.com/acme/company.git",
  PORT: "3000",
  SANOMA_WAKEUP_TOKEN: TOKEN,
};
/** The copy the upload names (`containers[].images`), pinned in the account's registry. */
const PINNED = `registry.cloudflare.com/0123456789abcdef0123456789abcdef/sanoma-ai-runtime@sha256:${"7".repeat(64)}`;
/** The image's label, as the object starts a container with it. */
const IMAGE = await digestLabel(PINNED);

/** A `ctx` that records what the object does: its container answers `answer` once started. */
function stubCtx({
  running = false,
  labels = { revision: "r2", image: IMAGE },
  images = { runtime: PINNED },
  answer = () => new Response("ok"),
  exits,
  drains = true,
}: {
  running?: boolean;
  labels?: Record<string, string>;
  images?: Record<string, string>;
  answer?: (request: Request) => Response;
  /** A container that ends as soon as it starts: how, as `monitor` rejects. */
  exits?: string;
  /** Whether its worker stops on SIGTERM. */
  drains?: boolean;
} = {}) {
  const storage = new Map<string, unknown>();
  const calls: string[] = [];
  const sent: Request[] = [];
  let alarm: number | null = null;
  const container: Omit<ObjectState["container"], "running"> & { running: boolean } = {
    running,
    images,
    start: vi.fn<ObjectState["container"]["start"]>((options) => {
      calls.push(`start ${options.labels.revision}`);
      container.running = true;
    }),
    inspect: vi.fn<ObjectState["container"]["inspect"]>(async () => (container.running ? { labels } : null)),
    signal: vi.fn<ObjectState["container"]["signal"]>((signal) => {
      calls.push(`signal ${signal}`);
      if (drains) container.running = false;
    }),
    destroy: vi.fn<ObjectState["container"]["destroy"]>(async () => {
      calls.push("destroy");
      container.running = false;
    }),
    getTcpPort: vi.fn<ObjectState["container"]["getTcpPort"]>((port) => ({
      fetch: async (input: string | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        sent.push(request);
        if (!container.running) throw new Error(`nothing on ${port}`);
        return answer(request);
      },
    })),
    setInactivityTimeout: vi.fn<ObjectState["container"]["setInactivityTimeout"]>(
      async (ms) => void calls.push(`timeout ${ms}`),
    ),
    monitor: () => {
      if (exits === undefined) return new Promise<void>(() => {});
      container.running = false;
      return Promise.reject(new Error(exits));
    },
  };
  const ctx: ObjectState = {
    container,
    storage: {
      get: async <T>(key: string) => storage.get(key) as T | undefined,
      put: async (key, value) => void storage.set(key, value),
      delete: async (key) => storage.delete(key),
      getAlarm: async () => alarm,
      setAlarm: async (at) => void (alarm = at),
      deleteAlarm: async () => void (alarm = null),
    },
    blockConcurrencyWhile: (fn) => fn(),
  };
  return { ctx, container, calls, sent, storage, alarm: () => alarm };
}

/** The labels of a container started at the Worker's revision and image, serving the sites' `domains`. */
const labelled = async (domains: string) => ({ revision: "r2", image: IMAGE, domains: await digestLabel(domains) });

/** A request to the object's route `path`, with the company's token unless `token` says otherwise. */
const route = (path: string, token: string | null = TOKEN) =>
  new Request(`https://sanoma-company.acme.workers.dev${path}`, {
    ...(token !== null && { headers: { authorization: `Bearer ${token}` } }),
  });
const START = "/__sanoma/health?start=1";

/** Has the object start its container, as a deploy's restart or a queued run does: the alarm `startNow` sets, rung. */
const started = async (object: Instance) => {
  await object.startNow();
  await object.alarm();
};

const wake = (method: string, { token = TOKEN, body }: { token?: string; body?: unknown } = {}) =>
  new Request("https://sanoma-company.acme.workers.dev/__sanoma/wake", {
    method,
    headers: { authorization: `Bearer ${token}` },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

describe("the Worker's object", () => {
  it("serves its wake where the runtime registers one (`WAKE_PATH`), which it cannot import", () => {
    expect(WAKE_PATH).toBe(RUNTIME_WAKE_PATH);
  });

  it("holds a wake only with the company's token, each registration replacing the one before", async () => {
    const { ctx, storage, alarm, container } = stubCtx();
    const object = new Instance(ctx, ENV);
    expect((await object.fetch(wake("GET", { token: "swi_another" }))).status).toBe(401);
    const unset = await new Instance(ctx, { ...ENV, SANOMA_WAKEUP_TOKEN: undefined }).fetch(wake("GET"));
    expect(unset.status).toBe(404);
    expect(await unset.json()).toEqual({ error: expect.stringContaining("SANOMA_WAKEUP_TOKEN") });
    expect(await (await object.fetch(wake("GET"))).json()).toEqual({ at: null });

    expect((await object.fetch(wake("PUT", { body: { at: "2099-01-01T00:00:00Z" } }))).status).toBe(204);
    expect(alarm()).toBe(Date.parse("2099-01-01T00:00:00Z"));
    // The next replaces it, earlier or later.
    await object.fetch(wake("PUT", { body: { at: "2098-01-01T00:00:00Z" } }));
    expect(await (await object.fetch(wake("GET"))).json()).toEqual({ at: "2098-01-01T00:00:00.000Z" });
    expect(alarm()).toBe(Date.parse("2098-01-01T00:00:00Z"));
    expect((await object.fetch(wake("PUT", { body: { at: "soon" } }))).status).toBe(400);

    expect((await object.fetch(wake("DELETE"))).status).toBe(204);
    expect(storage.size).toBe(0);
    expect(alarm()).toBeNull();
    // The wake route never starts the container.
    expect(container.start).not.toHaveBeenCalled();
  });

  it("answers the runtime's own routes and header, which it cannot import", () => {
    expect(APP_BUNDLE_PATH).toBe(RUNTIME_APP_BUNDLE_PATH);
    expect(CLIENT_IP_HEADER).toBe(RUNTIME_CLIENT_IP_HEADER);
  });

  it("answers its three routes alone, a start and the bundle only with the company's token", async () => {
    const { ctx, container } = stubCtx();
    const object = new Instance(ctx, ENV);
    expect((await object.fetch(route("/"))).status).toBe(404);
    expect((await object.fetch(route("/api/x"))).status).toBe(404);
    expect((await object.fetch(route(START, "swi_another"))).status).toBe(401);
    expect((await object.fetch(route(START, null))).status).toBe(401);
    expect((await object.fetch(route(`${APP_BUNDLE_PATH}?revision=r3`, "swi_another"))).status).toBe(401);
    expect(container.start).not.toHaveBeenCalled();
  });

  it("starts the container from an alarm when asked with the token, at the Worker's revision with its text bindings, once for asks at once", async () => {
    const { ctx, calls } = stubCtx();
    const object = new Instance(ctx, ENV);
    const asks = await Promise.all([object.fetch(route(START)), object.fetch(route(START))]);
    // The ask returns at once: the start is the alarm's, which outlives it.
    expect(asks.map((a) => a.status)).toEqual([202, 202]);
    expect(await asks[0]!.json()).toEqual({ revision: "r2", running: false, ready: false });
    expect(calls).toEqual([]);
    await object.alarm();
    expect(calls).toEqual(["start r2", `timeout ${INACTIVITY_MS}`]);
    const [options] = vi.mocked(ctx.container.start).mock.calls[0]!;
    // The image its upload names, at the instance type the object sets: the policy has the object say both.
    expect(options).toEqual({
      image: PINNED,
      instance: "standard-1",
      env: {
        SANOMA_REVISION: "r2",
        SANOMA_IMAGE: "ghcr.io/sanoma-ai/runtime:0.7.0",
        SANOMA_SOURCE: "https://github.com/acme/company.git",
        PORT: "3000",
        SANOMA_WAKEUP_TOKEN: TOKEN,
      },
      enableInternet: true,
      labels: { revision: "r2", image: IMAGE },
    });
    const ready = await object.fetch(route(START));
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ revision: "r2", running: true, ready: true });
    expect(vi.mocked(ctx.container.getTcpPort).mock.calls.every(([port]) => port === 3000)).toBe(true);
  });

  it("passes an ask for the app bundle on to the worker with the token once it runs, and starts it when it does not", async () => {
    const { ctx, sent } = stubCtx({
      answer: (r) =>
        new URL(r.url).pathname === APP_BUNDLE_PATH
          ? new Response('{"building":"r3"}', { status: 202 })
          : new Response("ok"),
    });
    const object = new Instance(ctx, ENV);
    const stopped = await object.fetch(route(`${APP_BUNDLE_PATH}?revision=r3`));
    expect(stopped.status).toBe(202);
    expect(await stopped.json()).toEqual({ starting: true });
    await object.alarm();
    const building = await object.fetch(route(`${APP_BUNDLE_PATH}?revision=r3`));
    expect(await building.json()).toEqual({ building: "r3" });
    const asked = sent.find((r) => new URL(r.url).pathname === APP_BUNDLE_PATH)!;
    expect(asked.url).toBe("http://container/__sanoma/app-bundle?revision=r3");
    expect(asked.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    ["revision", { revision: "r1", image: IMAGE }],
    ["image", { revision: "r2", image: "0123456789abcdef" }],
  ])(
    "drains a running container at another %s and starts it at the Worker's: a deploy's restart",
    async (_, labels) => {
      const { ctx, calls } = stubCtx({ running: true, labels });
      const object = new Instance(ctx, ENV);
      // The object restarted with its container running: the timeout is set again.
      expect(calls).toEqual([`timeout ${INACTIVITY_MS}`]);
      expect((await object.fetch(route(START))).status).toBe(202);
      await object.alarm();
      // SIGTERM, the worker's own stop: it stopped, so nothing was destroyed.
      expect(calls).toEqual([`timeout ${INACTIVITY_MS}`, "signal 15", "start r2", `timeout ${INACTIVITY_MS}`]);
      expect(await (await object.fetch(route(START))).json()).toEqual({ revision: "r2", running: true, ready: true });
    },
  );

  it("marks each answer with its version's id, the worker's passed on included, so a deploy tells its upload's from an earlier version's", async () => {
    const { ctx } = stubCtx({
      answer: (r) =>
        new URL(r.url).pathname === APP_BUNDLE_PATH
          ? Response.json({ building: "r3" }, { status: 202, headers: { "x-sanoma-app-bundle": "1" } })
          : new Response("ok"),
    });
    const serving = "00000002-0000-4000-a000-000000000000";
    const env = { ...ENV, CF_VERSION_METADATA: { id: serving, tag: "", timestamp: "" } };
    const object = new Instance(ctx, env);
    const answers = [
      await object.fetch(route("/__sanoma/health")),
      await object.fetch(route(`${APP_BUNDLE_PATH}?revision=r3`, "swi_another")),
      await object.fetch(route("/elsewhere")),
    ];
    await started(object);
    answers.push(await object.fetch(route(`${APP_BUNDLE_PATH}?revision=r3`)));
    expect(answers.map((a) => [a.status, a.headers.get(DEPLOYMENT_HEADER)])).toEqual([
      [200, serving],
      [401, serving],
      [404, serving],
      [202, serving],
    ]);
    // The worker's own answer, its marks kept.
    expect(answers[3]!.headers.get("x-sanoma-app-bundle")).toBe("1");
  });

  it("destroys a container whose worker has not stopped once the drain's time is up", async () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const { ctx, calls } = stubCtx({ running: true, labels: { revision: "r1", image: IMAGE }, drains: false });
    const object = new Instance(ctx, ENV);
    await object.startNow();
    const alarm = { rang: false };
    const ringing = object.alarm().finally(() => (alarm.rang = true));
    // A second at a time, for as long as it takes: the start digests its labels off the timers, in real time.
    while (!alarm.rang) await vi.advanceTimersByTimeAsync(1_000);
    await ringing;
    expect(calls).toEqual([`timeout ${INACTIVITY_MS}`, "signal 15", "destroy", "start r2", `timeout ${INACTIVITY_MS}`]);
  });

  it("throws from the alarm without starting a container when the Worker names no image", async () => {
    const { ctx, container } = stubCtx({ images: {} });
    const object = new Instance(ctx, ENV);
    await object.startNow();
    await expect(object.alarm()).rejects.toThrow('names no "runtime" image');
    expect(container.start).not.toHaveBeenCalled();
  });

  it("answers 503 when the container stops under an ask for the bundle, and starts it again on the next", async () => {
    const { ctx, container } = stubCtx({
      answer: (r) => {
        if (new URL(r.url).pathname !== APP_BUNDLE_PATH) return new Response("ok");
        throw new Error("the container is not running");
      },
    });
    const object = new Instance(ctx, ENV);
    await started(object);
    const answer = await object.fetch(route(`${APP_BUNDLE_PATH}?revision=r3`));
    expect(answer.status).toBe(503);
    expect(await answer.json()).toEqual({
      error: "the company's container did not answer: the container is not running",
    });
    expect((await object.fetch(route(`${APP_BUNDLE_PATH}?revision=r3`))).status).toBe(202);
    await object.alarm();
    // Running, but not known to answer: checked again rather than started again.
    expect(container.start).toHaveBeenCalledTimes(1);
  });

  it("gives up a start when the container ends, and says how to the next ask, once", async () => {
    const { ctx, container } = stubCtx({ exits: "Container exited with unexpected exit code: 1" });
    const object = new Instance(ctx, ENV);
    expect((await object.fetch(route(START))).status).toBe(202);
    await expect(object.alarm()).rejects.toThrow(
      "the container failed: Container exited with unexpected exit code: 1 before answering /healthz on port 3000",
    );
    const answer = await object.fetch(route(START));
    expect(answer.status).toBe(503);
    expect(await answer.json()).toEqual({
      error: expect.stringContaining("Container exited with unexpected exit code: 1"),
      exit: "the container failed: Container exited with unexpected exit code: 1",
    });
    expect(container.start).toHaveBeenCalledTimes(1);
    // Told once: the next ask starts it again.
    expect((await object.fetch(route(START))).status).toBe(202);
  });

  it("starts again when the platform has not assigned the application to the namespace yet", async () => {
    const { ctx, container } = stubCtx();
    let starts = 0;
    container.monitor = () => {
      if (++starts > 1) return new Promise<void>(() => {});
      container.running = false;
      return Promise.reject(new Error("There is no container application assigned to this Durable Object namespace"));
    };
    const object = new Instance(ctx, ENV);
    await started(object);
    const answer = await object.fetch(route(START));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ running: true, ready: true });
    expect(container.start).toHaveBeenCalledTimes(2);
  });

  it("ignores how an earlier container ended once another is starting", async () => {
    let checks = 0;
    const { ctx, container } = stubCtx({
      // The second container is not listening at its first check.
      answer: (request) =>
        new URL(request.url).pathname === "/healthz" && ++checks === 2
          ? new Response("starting", { status: 503 })
          : new Response("ok"),
    });
    let endFirst!: (error: Error) => void;
    let starts = 0;
    container.monitor = () =>
      new Promise<void>((_, reject) => {
        if (++starts === 1) endFirst = reject;
      });
    const object = new Instance(ctx, ENV);
    await started(object);
    // It crashed: the next start makes another, and the first container's end arrives at that start.
    container.running = false;
    vi.mocked(container.start).mockImplementationOnce(() => {
      container.running = true;
      endFirst(new Error("Container exited with unexpected exit code: 137"));
    });
    await started(object);
    expect(await (await object.fetch(route(START))).json()).toMatchObject({ ready: true });
    expect(container.start).toHaveBeenCalledTimes(2);
  });

  it("does not count a container that answered and then stopped as a start that failed", async () => {
    const { ctx, container } = stubCtx();
    let stop!: () => void;
    container.monitor = () => new Promise<void>((resolve) => (stop = resolve));
    const object = new Instance(ctx, ENV);
    await started(object);
    // Its worker was idle and exited 0: the container ended with it.
    container.running = false;
    stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // No `exit`: the next ask starts it again rather than refusing.
    expect(await (await object.fetch(route("/__sanoma/health", null))).json()).toEqual({
      revision: "r2",
      running: false,
      ready: false,
    });
    await started(object);
    expect(container.start).toHaveBeenCalledTimes(2);
    expect(await (await object.fetch(route(START))).json()).toMatchObject({ running: true, ready: true });
  });

  it("fails a wake whose worker closed its port to exit, and starts a fresh container on the alarm's retry once that one ended", async () => {
    let exiting = false;
    let stop!: () => void;
    const { ctx, container, sent } = stubCtx({
      answer: (r) => {
        // The worker decided to exit: its port is closed while its container still runs, and it
        // ends once the process is gone.
        if (exiting) {
          container.running = false;
          stop();
          throw new Error("connection refused");
        }
        return new Response(null, { status: new URL(r.url).pathname === "/wake" ? 204 : 200 });
      },
    });
    container.monitor = () => new Promise<void>((resolve) => (stop = resolve));
    const object = new Instance(ctx, ENV);
    await started(object);
    exiting = true;
    await object.startNow();
    await expect(object.alarm({ retryCount: 0, isRetry: false })).rejects.toThrow("connection refused");
    exiting = false;
    await object.alarm({ retryCount: 1, isRetry: true });
    expect(container.start).toHaveBeenCalledTimes(2);
    expect(sent.at(-1)!.url).toBe("http://container/wake");
    expect(await (await object.fetch(route(START))).json()).toMatchObject({ running: true, ready: true });
  });

  it("does not take a clean exit of the container before as the end of the one starting", async () => {
    const { ctx, container } = stubCtx();
    let endFirst!: () => void;
    let starts = 0;
    container.monitor = () =>
      new Promise<void>((resolve) => {
        if (++starts === 1) endFirst = resolve;
      });
    const object = new Instance(ctx, ENV);
    await started(object);
    // Its worker exited; the platform tells it only once the next start began.
    container.running = false;
    let reads = 0;
    const { images } = container;
    Object.defineProperty(container, "images", {
      get() {
        if (++reads === 1) endFirst();
        return images;
      },
    });
    await started(object);
    expect(container.start).toHaveBeenCalledTimes(2);
    expect(await (await object.fetch(route(START))).json()).toMatchObject({ ready: true });
  });

  it("starts the new revision when a deploy's drain finds the container already ending, its worker idle", async () => {
    const { ctx, container } = stubCtx({ running: true, labels: { revision: "r1", image: IMAGE } });
    // The worker exited as the drain came: the container is gone, and the signal finds none.
    vi.mocked(container.signal).mockImplementation(() => {
      container.running = false;
      throw new Error("the container is not running");
    });
    const object = new Instance(ctx, ENV);
    await started(object);
    expect(container.start).toHaveBeenCalledWith(expect.objectContaining({ labels: { revision: "r2", image: IMAGE } }));
    expect(await (await object.fetch(route(START))).json()).toMatchObject({ running: true, ready: true });
  });

  it("answers its health to anyone without starting the container", async () => {
    const { ctx, container } = stubCtx();
    const health = await new Instance(ctx, ENV).fetch(route("/__sanoma/health", null));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ revision: "r2", running: false, ready: false });
    expect(container.start).not.toHaveBeenCalled();
  });

  it("starts the container again when the sites' domains change, which its environment names", async () => {
    const env = { ...ENV, SANOMA_DOMAINS: "www=new.acme.example" };
    const moved = stubCtx({ running: true, labels: await labelled("www=old.acme.example") });
    await started(new Instance(moved.ctx, env));
    expect(moved.calls).toContain("signal 15");
    expect(moved.container.start).toHaveBeenCalledWith(
      expect.objectContaining({ labels: await labelled("www=new.acme.example") }),
    );
    const kept = stubCtx({ running: true, labels: await labelled("www=new.acme.example") });
    await started(new Instance(kept.ctx, env));
    expect(kept.container.signal).not.toHaveBeenCalled();
  });

  it("keeps a running container at the Worker's revision and image", async () => {
    const { ctx, container } = stubCtx({ running: true });
    await started(new Instance(ctx, ENV));
    expect(container.signal).not.toHaveBeenCalled();
    expect(container.destroy).not.toHaveBeenCalled();
    expect(container.start).not.toHaveBeenCalled();
  });

  it("rings its alarm by starting the container and sending /wake", async () => {
    const { ctx, sent } = stubCtx({
      answer: (r) => new Response(null, { status: new URL(r.url).pathname === "/wake" ? 204 : 200 }),
    });
    const object = new Instance(ctx, ENV);
    await object.alarm();
    expect(sent).toEqual([]);
    await object.fetch(wake("PUT", { body: { at: "2000-01-01T00:00:00Z" } }));
    await object.alarm();
    expect(sent.at(-1)!.url).toBe("http://container/wake");
    expect(await (await object.fetch(wake("GET"))).json()).toEqual({
      at: "2000-01-01T00:00:00.000Z",
      rang: expect.stringMatching(/^\d{4}-/),
    });
  });

  it("throws from its alarm when /wake fails, so Cloudflare rings it again", async () => {
    const { ctx } = stubCtx({
      answer: (r) => new Response(null, { status: new URL(r.url).pathname === "/wake" ? 503 : 200 }),
    });
    const object = new Instance(ctx, ENV);
    await object.fetch(wake("PUT", { body: { at: "2000-01-01T00:00:00Z" } }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(object.alarm()).rejects.toThrow("the container answered /wake with 503");
  });

  it("starts the container from an alarm at startNow, without the caller waiting, wakes it and sets a later wake again", async () => {
    const { ctx, calls, sent, alarm } = stubCtx();
    const object = new Instance(ctx, ENV);
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    await object.fetch(wake("PUT", { body: { at: later } }));
    await object.startNow();
    expect(calls).toEqual([]);
    expect(alarm()).toBeLessThanOrEqual(Date.now());
    await object.alarm();
    expect(calls).toEqual(["start r2", `timeout ${INACTIVITY_MS}`]);
    expect(sent.at(-1)!.url).toBe("http://container/wake");
    expect(alarm()).toBe(Date.parse(later));
    expect(await (await object.fetch(wake("GET"))).json()).toEqual({ at: later });
  });

  it("sends /wake at startNow to a container that is up, whose worker may have stopped itself", async () => {
    const { ctx, container, sent } = stubCtx({ running: true });
    const object = new Instance(ctx, ENV);
    await started(object);
    sent.length = 0;
    await object.startNow();
    await object.alarm();
    expect(container.start).not.toHaveBeenCalled();
    expect(sent.map((r) => r.url)).toEqual(["http://container/wake"]);
  });

  it("keeps the alarm of a start asked for when a wake is registered or cleared meanwhile", async () => {
    const { ctx, calls, alarm } = stubCtx();
    const object = new Instance(ctx, ENV);
    await object.startNow();
    const now = alarm();
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    await object.fetch(wake("PUT", { body: { at: later } }));
    expect(alarm()).toBe(now);
    await object.fetch(wake("DELETE"));
    expect(alarm()).toBe(now);
    await object.alarm();
    expect(calls).toContain("start r2");
  });

  it("retries a start asked for that fails, then gives it up and keeps the later wake", async () => {
    const { ctx, storage, alarm } = stubCtx({ exits: "out of capacity" });
    const object = new Instance(ctx, ENV);
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    await object.fetch(wake("PUT", { body: { at: later } }));
    await object.startNow();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(object.alarm({ retryCount: 0, isRetry: false })).rejects.toThrow("out of capacity");
    expect(storage.has("start")).toBe(true);
    await object.alarm({ retryCount: 5, isRetry: true });
    expect(storage.has("start")).toBe(false);
    expect(alarm()).toBe(Date.parse(later));
  });

  it("leaves an alarm due sooner than now as it is at startNow, sends one /wake for both, and never rings a wake twice", async () => {
    const { ctx, sent, alarm } = stubCtx({
      answer: (r) => new Response(null, { status: new URL(r.url).pathname === "/wake" ? 204 : 200 }),
    });
    const object = new Instance(ctx, ENV);
    const wakes = () => sent.filter((r) => new URL(r.url).pathname === "/wake").length;
    await object.fetch(wake("PUT", { body: { at: "2000-01-01T00:00:00Z" } }));
    await object.startNow();
    expect(alarm()).toBe(Date.parse("2000-01-01T00:00:00Z"));
    await object.alarm();
    expect(wakes()).toBe(1);
    await object.alarm();
    expect(wakes()).toBe(1);
    const { rang } = (await (await object.fetch(wake("GET"))).json()) as { rang: string };
    await object.startNow();
    await object.alarm();
    expect(wakes()).toBe(2);
    expect(await (await object.fetch(wake("GET"))).json()).toEqual({ at: "2000-01-01T00:00:00.000Z", rang });
  });

  it("exports the object class over the platform's DurableObject from its entry module", async () => {
    const entry = (await import(new URL("../worker/index.js", import.meta.url).href)) as {
      SanomaInstance: new (ctx: unknown, env: unknown) => unknown;
    };
    const { ctx } = stubCtx();
    const object = entry.SanomaInstance && new entry.SanomaInstance(ctx, ENV);
    expect(object).toMatchObject({ ctx, env: ENV });
  });
});

/** An object whose routes answer `from the object`, its `startNow` recorded. */
const objectStub = () => {
  const startNow = vi.fn<() => Promise<void>>(async () => {});
  const fetch = vi.fn<(request: Request) => Promise<Response>>(async () => new Response("from the object"));
  const getByName = vi.fn<(name: string) => object>(() => ({ fetch, startNow }));
  return { env: { SANOMA_INSTANCE: { getByName } }, startNow, fetch, getByName };
};

describe("the Worker script", () => {
  const ctx = { waitUntil: () => {} };

  it("hands the object its routes, and answers the Host contract's /wake by having it start the worker", async () => {
    const { env, fetch, startNow, getByName } = objectStub();
    const app = vi.fn<() => Promise<Response>>();
    const load = async () => ({ default: { fetch: app } });
    for (const path of [WAKE_PATH, "/__sanoma/health", `${APP_BUNDLE_PATH}?revision=r3`]) {
      expect(await (await serve(route(path), env, ctx, load)).text()).toBe("from the object");
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    const woken = await serve(route("/wake", null), env, ctx, load);
    expect(woken.status).toBe(204);
    expect(startNow).toHaveBeenCalledOnce();
    expect(getByName.mock.calls.every(([name]) => name === "instance")).toBe(true);
    expect(app).not.toHaveBeenCalled();
  });

  it("answers everything else with the app bundle, the visitor's address from Cloudflare alone and the object's start as its host", async () => {
    const { env, startNow } = objectStub();
    let seen: { request: Request; host: { startNow(): Promise<unknown> } } | undefined;
    const load = vi.fn<Parameters<typeof serve>[3]>(async () => ({
      default: {
        fetch: async (request: Request, _env: unknown, _ctx: unknown, host: { startNow(): Promise<unknown> }) => {
          seen = { request, host };
          return new Response("from the app");
        },
      },
    }));
    const visitor = new Request("https://www.acme.example/pricing?plan=pro", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.7", [CLIENT_IP_HEADER]: "10.0.0.1" },
      body: "hello",
    });
    const answer = await serve(visitor, env, ctx, load);
    expect(await answer.text()).toBe("from the app");
    expect(seen!.request.url).toBe("https://www.acme.example/pricing?plan=pro");
    expect(await seen!.request.text()).toBe("hello");
    // The client's own copy is overwritten.
    expect(seen!.request.headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.7");
    await seen!.host.startNow();
    expect(startNow).toHaveBeenCalledOnce();
    // A GET of /wake is the contract's; a page of the app at another method is the app's.
    await serve(new Request("https://www.acme.example/wake", { method: "POST" }), env, ctx, load);
    expect(load).toHaveBeenCalledTimes(2);
    // Without Cloudflare's header, no address: never the client's.
    const bare = new Request("https://www.acme.example/", { headers: { [CLIENT_IP_HEADER]: "10.0.0.1" } });
    await serve(bare, env, ctx, load);
    expect(seen!.request.headers.get(CLIENT_IP_HEADER)).toBe("");
  });

  it("imports the app the upload puts under app/ from its entry, and the placeholder answers 503 on a Worker that never served an app", async () => {
    // The Worker as the upload lays it out: the package's modules, and `app/index.js` beside them.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-worker-")));
    try {
      cpSync(fileURLToPath(new URL("../worker/", import.meta.url)), dir, { recursive: true });
      mkdirSync(join(dir, "app"));
      writeFileSync(
        join(dir, "app", "index.js"),
        `export default { fetch: async () => new Response("from the app") };`,
      );
      const entry = (await import(pathToFileURL(join(dir, "index.js")).href)) as {
        default: { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> };
      };
      const { env } = objectStub();
      expect(await (await entry.default.fetch(new Request("https://www.acme.example/"), env, ctx)).text()).toBe(
        "from the app",
      );
      const placeholder = (await import(pathToFileURL(join(dir, "no-app.js")).href)) as {
        default: { fetch(): Response };
      };
      const answer = placeholder.default.fetch();
      expect(answer.status).toBe(503);
      expect(answer.headers.get("retry-after")).toBe("30");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
