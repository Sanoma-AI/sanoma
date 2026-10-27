import { describe, expect, it, vi } from "vitest";
import { imageLabel, Instance, INACTIVITY_MS, type ObjectState, worker } from "../worker/instance.js";

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

const TOKEN = "swi_the-company-token";
const ENV = {
  SANOMA_INSTANCE: { not: "a string" },
  SANOMA_REVISION: "r2",
  SANOMA_IMAGE: "ghcr.io/sanoma-ai/runtime:0.7.0",
  SANOMA_SOURCE: "https://github.com/acme/company.git",
  PORT: "3000",
  SANOMA_WAKEUP_TOKEN: TOKEN,
};
/** The image's label, as the object starts a container with it. */
const IMAGE = await imageLabel(ENV.SANOMA_IMAGE);

/** A `ctx` that records what the object does: its container answers `answer` once started. */
function stubCtx({
  running = false,
  labels = { revision: "r2", image: IMAGE },
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
    inspect: vi.fn<ObjectState["container"]["inspect"]>(async () => (container.running ? { labels } : null)),
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

  it("starts the container at the Worker's revision with its text bindings, once for requests at once, and proxies", async () => {
    const { ctx, calls, sent } = stubCtx({ answer: (r) => new Response(`${new URL(r.url).pathname} ok`) });
    const object = new Instance(ctx, ENV);
    const ask = () =>
      object.fetch(
        new Request("https://sanoma-company.acme.workers.dev/api/x?y=1", { headers: { host: "elsewhere" } }),
      );
    const answers = await Promise.all([ask(), ask()]);
    expect(await Promise.all(answers.map((a) => a.text()))).toEqual(["/api/x ok", "/api/x ok"]);
    expect(calls).toEqual(["start r2", `timeout ${INACTIVITY_MS}`]);
    const [options] = vi.mocked(ctx.container.start).mock.calls[0]!;
    expect(options).toEqual({
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
    const proxied = sent.filter((r) => new URL(r.url).pathname === "/api/x");
    expect(proxied.map((r) => r.url)).toEqual(["http://container/api/x?y=1", "http://container/api/x?y=1"]);
    expect(proxied[0]!.headers.get("host")).toBeNull();
    expect(vi.mocked(ctx.container.getTcpPort).mock.calls.every(([port]) => port === 3000)).toBe(true);
  });

  it.each([
    ["revision", { revision: "r1", image: IMAGE }],
    ["image", { revision: "r2", image: "0123456789abcdef" }],
  ])("destroys a running container at another %s and starts it at the Worker's: a deploy", async (_, labels) => {
    const { ctx, calls } = stubCtx({ running: true, labels });
    const object = new Instance(ctx, ENV);
    // The object restarted with its container running: the timeout is set again.
    expect(calls).toEqual([`timeout ${INACTIVITY_MS}`]);
    const health = await object.fetch(new Request("https://sanoma-company.acme.workers.dev/__sanoma/health?start=1"));
    expect(await health.json()).toEqual({ revision: "r2", running: true });
    expect(calls).toEqual([`timeout ${INACTIVITY_MS}`, "destroy", "start r2", `timeout ${INACTIVITY_MS}`]);
  });

  it("answers 503 when the container stops under a request, and checks it again on the next", async () => {
    const { ctx, sent } = stubCtx({
      answer: (r) => {
        if (new URL(r.url).pathname === "/healthz") return new Response("ok");
        throw new Error("the container is not running");
      },
    });
    const object = new Instance(ctx, ENV);
    const answer = await object.fetch(new Request("https://x.workers.dev/api/x"));
    expect(answer.status).toBe(503);
    expect(await answer.json()).toEqual({
      error: "the company's container did not answer: the container is not running",
    });
    await object.fetch(new Request("https://x.workers.dev/api/x"));
    expect(sent.filter((r) => new URL(r.url).pathname === "/healthz")).toHaveLength(2);
  });

  it("answers its health without starting the container, unless asked to", async () => {
    const { ctx, container } = stubCtx();
    const health = await new Instance(ctx, ENV).fetch(new Request("https://x.workers.dev/__sanoma/health"));
    expect(await health.json()).toEqual({ revision: "r2", running: false });
    expect(container.start).not.toHaveBeenCalled();
  });

  it("keeps a running container at the Worker's revision and image", async () => {
    const { ctx, container } = stubCtx({ running: true });
    expect((await new Instance(ctx, ENV).fetch(new Request("https://x.workers.dev/healthz"))).status).toBe(200);
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

  it("sends every request of the Worker to its one object", async () => {
    const getByName = vi.fn<(name: string) => { fetch(): Promise<Response> }>(() => ({
      fetch: async () => new Response("from the object"),
    }));
    const answer = await worker.fetch(new Request("https://x.workers.dev/"), { SANOMA_INSTANCE: { getByName } });
    expect(await answer.text()).toBe("from the object");
    expect(getByName).toHaveBeenCalledWith("instance");
  });

  it("exports the object class over the platform's DurableObject from its entry module", async () => {
    const entry = (await import(new URL("../worker/index.js", import.meta.url).href)) as {
      SanomaInstance: new (ctx: unknown, env: unknown) => unknown;
      default: unknown;
    };
    const { ctx } = stubCtx();
    const object = entry.SanomaInstance && new entry.SanomaInstance(ctx, ENV);
    expect(object).toMatchObject({ ctx, env: ENV });
    expect(entry.default).toBe(worker);
  });
});
