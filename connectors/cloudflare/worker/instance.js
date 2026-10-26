// The company's Durable Object, `SanomaInstance`, without the platform: `index.js` extends
// `DurableObject` from `cloudflare:workers` with it, and the connector's fake runs it in Node over
// a stubbed `ctx`, so both kits check this code. No imports, so Node loads it as it is.
//
// The object runs the company's container (`ctx.container`): it starts it on a request, at the
// revision and image the Worker's `SANOMA_REVISION` and `SANOMA_IMAGE` name (a running one at
// another is destroyed and started again: a deploy), waits for `/healthz`, and proxies every
// request to it. It answers `/__sanoma/health` without starting it (with `?start=1`, once it
// runs), and holds the company's one wake (`/__sanoma/wake`) as an alarm, which starts the
// container at `at` and calls its `/wake?generation=N`.

/** The object's own route: the wake it holds. */
export const WAKE_PATH = "/__sanoma/wake";
/** The object's route that answers `{ revision, running }`; with `?start=1`, once the container answers `/healthz`: what a deploy waits for. */
export const HEALTH_PATH = "/__sanoma/health";
/** How long the container keeps running after the last request: Cloudflare stops it then. */
export const INACTIVITY_MS = 10 * 60 * 1000;
/** How long a start may take to answer `/healthz`: a cold start clones the source and installs it. */
const START_TIMEOUT_MS = 10 * 60 * 1000;
/** How long one try of a starting container's `/healthz` may take. */
const TRY_MS = 5_000;
/** How long between two tries of a starting container's `/healthz`. */
const POLL_MS = 250;
/** Where the wake is kept, in the object's storage. */
const WAKE_KEY = "wake";
/** The binding that names the object, in the Worker's env. */
export const NAMESPACE = "SANOMA_INSTANCE";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const problem = (status, error) => json(status, { error });

/** The Worker's text bindings (plain text and secrets): the container's environment. */
function containerEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string"));
}

/** The label naming an image: a digest of it, as a label holds 64 bytes and a pinned image is longer. */
export async function imageLabel(image) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(image));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when two strings are equal, in a time that does not tell how much of them is. */
function sameToken(given, expected) {
  let differ = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) differ |= (given.charCodeAt(i) ^ expected.charCodeAt(i)) | 0;
  return differ === 0;
}

/** A registration, `{ at, generation }`, from a PUT's JSON body; undefined when it is none. */
function parseRegistration(body) {
  if (typeof body !== "object" || body === null) return undefined;
  const { at, generation } = body;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return undefined;
  if (!Number.isSafeInteger(generation) || generation < 1) return undefined;
  return { at: new Date(at).toISOString(), generation };
}

export class Instance {
  /** The start in progress, which every request waits on. */
  #starting;
  /** True once a container this object started (or found) answered `/healthz`. */
  #ready = false;

  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // An object that restarts (a deploy) starts without the timeout, though its container runs.
    const container = ctx.container;
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_MS));
  }

  get port() {
    return Number(this.env.PORT);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === WAKE_PATH) return this.wake(request);
    const health = url.pathname === HEALTH_PATH;
    // A read asks without starting the container: a stopped host is a healthy one.
    if (health && !url.searchParams.has("start")) return this.health();
    try {
      await this.ensureRunning();
    } catch (error) {
      return problem(503, `the company's container did not start: ${error?.message ?? error}`);
    }
    if (health) return this.health();
    const headers = new Headers(request.headers);
    headers.delete("host");
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
    const forwarded = new Request(new URL(url.pathname + url.search, "http://container"), {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      ...(body && { duplex: "half" }),
    });
    return this.ctx.container.getTcpPort(this.port).fetch(forwarded);
  }

  /** What the Worker runs, and whether its container does. */
  health() {
    return json(200, { revision: this.env.SANOMA_REVISION ?? "", running: this.ctx.container.running });
  }

  /** Starts the container at the Worker's revision and image unless it runs them and answered; one start at a time. */
  ensureRunning() {
    if (this.#ready && this.ctx.container.running) return Promise.resolve();
    this.#starting ??= this.#start().finally(() => (this.#starting = undefined));
    return this.#starting;
  }

  async #start() {
    this.#ready = false;
    const container = this.ctx.container;
    const labels = { revision: this.env.SANOMA_REVISION ?? "", image: await imageLabel(this.env.SANOMA_IMAGE ?? "") };
    if (container.running) {
      // One it cannot say it started at these is not kept either.
      const info = await container.inspect();
      const same = info && info.labels?.revision === labels.revision && (info.labels?.image ?? "") === labels.image;
      if (!same) await container.destroy("a new revision or image");
    }
    const until = Date.now() + START_TIMEOUT_MS;
    let last;
    while (Date.now() < until) {
      try {
        if (!container.running) {
          container.start({ env: containerEnv(this.env), enableInternet: true, labels });
        }
        // A try of its own time: a hung one would hold every request past the deadline.
        const res = await container
          .getTcpPort(this.port)
          .fetch("http://container/healthz", { signal: AbortSignal.timeout(TRY_MS) });
        await res.body?.cancel();
        if (res.ok) {
          await container.setInactivityTimeout(INACTIVITY_MS);
          this.#ready = true;
          return;
        }
        last = `/healthz answered ${res.status}`;
      } catch (error) {
        // Not listening yet, or not yet free to start again after a destroy.
        last = error?.message ?? String(error);
      }
      await sleep(POLL_MS);
    }
    throw new Error(`no answer from /healthz on port ${this.port} in ${START_TIMEOUT_MS / 1000} s (${last})`);
  }

  /** `/__sanoma/wake`, with the company's `SANOMA_WAKEUP_TOKEN`: the wake this object holds. */
  async wake(request) {
    const token = this.env.SANOMA_WAKEUP_TOKEN;
    if (!token) return problem(404, "no wakeup here: SANOMA_WAKEUP_TOKEN is not among the host's secrets");
    if (!sameToken(request.headers.get("authorization") ?? "", `Bearer ${token}`)) {
      return problem(401, "the token is not this host's SANOMA_WAKEUP_TOKEN");
    }
    const storage = this.ctx.storage;
    if (request.method === "GET") return json(200, (await storage.get(WAKE_KEY)) ?? { at: null, generation: 0 });
    if (request.method === "DELETE") {
      await storage.delete(WAKE_KEY);
      await storage.deleteAlarm();
      return new Response(null, { status: 204 });
    }
    if (request.method !== "PUT") return problem(405, "GET, PUT or DELETE");
    const wake = parseRegistration(await request.json().catch(() => undefined));
    if (!wake) return problem(400, "the body must be { at: an ISO 8601 time, generation: an integer from 1 }");
    const held = await storage.get(WAKE_KEY);
    // Only a newer generation replaces the wake: registrations arrive at least once, in any order.
    if (!held || wake.generation > held.generation) {
      await storage.put(WAKE_KEY, wake);
      await storage.setAlarm(Date.parse(wake.at));
    }
    return new Response(null, { status: 204 });
  }

  /** The wake is due: start the container and send it `/wake`, then note when. A throw makes Cloudflare retry the alarm. */
  async alarm() {
    const wake = await this.ctx.storage.get(WAKE_KEY);
    if (!wake) return;
    await this.ensureRunning();
    const at = `http://container/wake?generation=${wake.generation}`;
    const res = await this.ctx.container.getTcpPort(this.port).fetch(at);
    await res.body?.cancel();
    if (!res.ok) {
      console.error(`GET /wake?generation=${wake.generation} answered ${res.status}`);
      throw new Error(`the container answered /wake with ${res.status}`);
    }
    // When it rang, which a GET shows: unless a newer wake replaced it meanwhile.
    const held = await this.ctx.storage.get(WAKE_KEY);
    if (held?.generation === wake.generation)
      await this.ctx.storage.put(WAKE_KEY, { ...held, rang: new Date().toISOString() });
  }
}

/** The Worker's default export: every request goes to the one object. */
export const worker = {
  fetch: (request, env) => env[NAMESPACE].getByName("instance").fetch(request),
};
