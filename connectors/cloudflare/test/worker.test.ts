import { describe, expect, it, vi } from "vitest";
import * as names from "../src/worker.ts";
import type { InstanceModule, ObjectState } from "../src/worker.ts";

// The Worker's own code, `worker/instance.js`, over a stubbed `ctx`: the routes of its object,
// the start of its container, the proxy and the alarm. The kits run it over the fake's `ctx`
// (`host.test.ts`, `wakeup.test.ts`); `index.js`, which only extends `DurableObject` with it, runs
// on Cloudflare (Miniflare would run it here, which this package does not add).

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

const code = (name: string) => import(new URL(`../worker/${name}`, import.meta.url).href);
const { Instance, worker, ...constants } = (await code("instance.js")) as InstanceModule & Record<string, unknown>;

const TOKEN = "swi_the-company-token";
const ENV = {
  SANOMA_INSTANCE: { not: "a string" },
  SANOMA_REVISION: "r2",
  SANOMA_SOURCE: "https://github.com/acme/company.git",
  PORT: "3000",
  SANOMA_WAKEUP_TOKEN: TOKEN,
};

/** A `ctx` that records what the object does: its container answers `answer` once started. */
function stubCtx({
  running = false,
  labels = { revision: "r2" },
  answer = () => new Response("ok"),
}: { running?: boolean; labels?: Record<string, string>; answer?: (request: Request) => Response } = {}) {
  const storage = new Map<string, unknown>();
  const calls: string[] = [];
  const sent: Request[] = [];
  let alarm: number | null = null;
  const container: Omit<ObjectState["container"], "running"> & { running: boolean } = {
    running,
    start: vi.fn<ObjectState["container"]["start"]>((options) => {
      calls.push(`start ${options.labels.revision}`);
      container.running = true;
    }),
    inspect: vi.fn<ObjectState["container"]["inspect"]>(async () => (container.running ? { image: "", labels } : null)),
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
  };
  const ctx: ObjectState = {
    container,
    storage: {
      get: async <T>(key: string) => storage.get(key) as T | undefined,
      put: async (key, value) => void storage.set(key, value),
      delete: async (key) => storage.delete(key),
      setAlarm: async (at) => void (alarm = at),
      deleteAlarm: async () => void (alarm = null),
    },
    blockConcurrencyWhile: (fn) => fn(),
  };
  return { ctx, container, calls, sent, storage, alarm: () => alarm };
}

const wake = (method: string, { token = TOKEN, body }: { token?: string; body?: unknown } = {}) =>
  new Request("https://sanoma-company.acme.workers.dev/__sanoma/wake", {
    method,
    headers: { authorization: `Bearer ${token}` },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

describe("the Worker's object", () => {
  it("names its routes and bindings as the connector does", () => {
    expect(constants).toMatchObject({
      WAKE_PATH: names.WAKE_PATH,
      HEALTH_PATH: names.HEALTH_PATH,
      NAMESPACE: names.NAMESPACE,
      INACTIVITY_MS: names.INACTIVITY_MS,
    });
  });

  it("holds a wake only with the company's token, and only a newer generation", async () => {
    const { ctx, storage, alarm, container } = stubCtx();
    const object = new Instance(ctx, ENV);
    expect((await object.fetch(wake("GET", { token: "swi_another" }))).status).toBe(401);
    const unset = await new Instance(ctx, { ...ENV, SANOMA_WAKEUP_TOKEN: undefined }).fetch(wake("GET"));
    expect(unset.status).toBe(404);
    expect(await unset.json()).toEqual({ error: expect.stringContaining("SANOMA_WAKEUP_TOKEN") });
    expect(await (await object.fetch(wake("GET"))).json()).toEqual({ at: null, generation: 0 });

    expect((await object.fetch(wake("PUT", { body: { at: "2099-01-01T00:00:00Z", generation: 2 } }))).status).toBe(204);
    expect(alarm()).toBe(Date.parse("2099-01-01T00:00:00Z"));
    // A late retry of an older one changes nothing.
    await object.fetch(wake("PUT", { body: { at: "2098-01-01T00:00:00Z", generation: 1 } }));
    expect(await (await object.fetch(wake("GET"))).json()).toEqual({ at: "2099-01-01T00:00:00.000Z", generation: 2 });
    expect(alarm()).toBe(Date.parse("2099-01-01T00:00:00Z"));
    expect((await object.fetch(wake("PUT", { body: { at: "soon", generation: 3 } }))).status).toBe(400);

    expect((await object.fetch(wake("DELETE"))).status).toBe(204);
    expect(storage.size).toBe(0);
    expect(alarm()).toBeNull();
    // The wake route never starts the container.
    expect(container.start).not.toHaveBeenCalled();
  });

  it("starts the container at the Worker's revision with its text bindings, once for requests at once, and proxies", async () => {
    const { ctx, calls, sent } = stubCtx({ answer: (r) => new Response(`${new URL(r.url).pathname} ok`) });
    const object = new Instance(ctx, ENV);
    const ask = () =>
      object.fetch(
        new Request("https://sanoma-company.acme.workers.dev/api/x?y=1", { headers: { host: "elsewhere" } }),
      );
    const answers = await Promise.all([ask(), ask()]);
    expect(await Promise.all(answers.map((a) => a.text()))).toEqual(["/api/x ok", "/api/x ok"]);
    expect(calls).toEqual(["start r2", `timeout ${10 * 60 * 1000}`]);
    const [options] = vi.mocked(ctx.container.start).mock.calls[0]!;
    expect(options).toEqual({
      env: {
        SANOMA_REVISION: "r2",
        SANOMA_SOURCE: "https://github.com/acme/company.git",
        PORT: "3000",
        SANOMA_WAKEUP_TOKEN: TOKEN,
      },
      enableInternet: true,
      labels: { revision: "r2" },
    });
    const proxied = sent.filter((r) => new URL(r.url).pathname === "/api/x");
    expect(proxied.map((r) => r.url)).toEqual(["http://container/api/x?y=1", "http://container/api/x?y=1"]);
    expect(proxied[0]!.headers.get("host")).toBeNull();
    expect(vi.mocked(ctx.container.getTcpPort).mock.calls.every(([port]) => port === 3000)).toBe(true);
  });

  it("destroys a running container at another revision and starts it at the Worker's: a deploy", async () => {
    const { ctx, calls } = stubCtx({ running: true, labels: { revision: "r1" } });
    const object = new Instance(ctx, ENV);
    // The object restarted with its container running: the timeout is set again.
    expect(calls).toEqual([`timeout ${10 * 60 * 1000}`]);
    const health = await object.fetch(new Request("https://sanoma-company.acme.workers.dev/__sanoma/health"));
    expect(await health.json()).toEqual({ revision: "r2" });
    expect(calls).toEqual([`timeout ${10 * 60 * 1000}`, "destroy", "start r2", `timeout ${10 * 60 * 1000}`]);
  });

  it("keeps a running container at the Worker's revision", async () => {
    const { ctx, container } = stubCtx({ running: true });
    expect((await new Instance(ctx, ENV).fetch(new Request("https://x.workers.dev/healthz"))).status).toBe(200);
    expect(container.destroy).not.toHaveBeenCalled();
    expect(container.start).not.toHaveBeenCalled();
  });

  it("rings its alarm by starting the container and sending /wake with the generation", async () => {
    const { ctx, sent } = stubCtx({
      answer: (r) => new Response(null, { status: new URL(r.url).pathname === "/wake" ? 204 : 200 }),
    });
    const object = new Instance(ctx, ENV);
    await object.alarm();
    expect(sent).toEqual([]);
    await object.fetch(wake("PUT", { body: { at: "2000-01-01T00:00:00Z", generation: 7 } }));
    await object.alarm();
    expect(sent.at(-1)!.url).toBe("http://container/wake?generation=7");
    expect(await (await object.fetch(wake("GET"))).json()).toEqual({
      at: "2000-01-01T00:00:00.000Z",
      generation: 7,
      rang: expect.stringMatching(/^\d{4}-/),
    });
  });

  it("throws from its alarm when /wake fails, so Cloudflare rings it again", async () => {
    const { ctx } = stubCtx({
      answer: (r) => new Response(null, { status: new URL(r.url).pathname === "/wake" ? 503 : 200 }),
    });
    const object = new Instance(ctx, ENV);
    await object.fetch(wake("PUT", { body: { at: "2000-01-01T00:00:00Z", generation: 1 } }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(object.alarm()).rejects.toThrow("the container answered /wake with 503");
  });

  it("sends every request of the Worker to its one object", async () => {
    const getByName = vi.fn<(name: string) => { fetch(): Promise<Response> }>(() => ({
      fetch: async () => new Response("from the object"),
    }));
    const answer = await worker.fetch(new Request("https://x.workers.dev/"), { SANOMA_INSTANCE: { getByName } });
    expect(await answer.text()).toBe("from the object");
    expect(getByName).toHaveBeenCalledWith("instance");
  });

  it("exports the object class over the platform's DurableObject from its entry module", async () => {
    const entry = (await code("index.js")) as {
      SanomaInstance: new (ctx: unknown, env: unknown) => unknown;
      default: unknown;
    };
    const { ctx } = stubCtx();
    const object = entry.SanomaInstance && new entry.SanomaInstance(ctx, ENV);
    expect(object).toMatchObject({ ctx, env: ENV });
    expect(entry.default).toBe(worker);
  });
});
