// The company's Durable Object, `SanomaInstance`, without the platform: `index.js` extends
// `DurableObject` from `cloudflare:workers` with it, and the connector's fake runs it in Node over
// a stubbed `ctx`, so both kits check this code. No imports, so Node loads it as it is.
//
// The object runs the company's container (`ctx.container`): it starts it on a request, at the
// Worker's `SANOMA_REVISION` and the image its upload names (`ctx.container.images.runtime`, as
// the `durable_object` scheduling policy has it: the object says what runs), a running one at
// another destroyed and started again (a deploy); it waits for `/healthz`, and proxies every
// request to it. It answers `/__sanoma/health` without starting it (with `?start=1`, once it
// runs), and holds the company's one wake (`/__sanoma/wake`) as an alarm, which starts the
// container at `at` and calls its `/wake`.

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
/** The longest wait between two tries. */
const MAX_POLL_MS = 1_000;
/** Where the wake is kept, in the object's storage. */
const WAKE_KEY = "wake";
/** The binding that names the object, in the Worker's env. */
export const NAMESPACE = "SANOMA_INSTANCE";
/** The name the upload gives the runtime image (`containers[].images`), which the object starts. */
export const IMAGE = "runtime";
/** The container's size, one of the named types `start` takes: ½ vCPU, 4 GiB (`basic`, ¼ vCPU, is refused under this policy). */
export const INSTANCE_TYPE = "standard-1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A refusal; with `exit`, how the container ended: a deploy stops waiting on it. */
const problem = (status, error, exit) => json(status, { error, ...(exit !== undefined && { exit }) });

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

/** A registration, `{ at }`, from a PUT's JSON body; undefined when it is none. */
function parseRegistration(body) {
  if (typeof body !== "object" || body === null) return undefined;
  const { at } = body;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return undefined;
  return { at: new Date(at).toISOString() };
}

export class Instance {
  /** The start in progress, which every request waits on. */
  #starting;
  /** True once a container this object started (or found) answered `/healthz`. */
  #ready = false;
  /** What the last try of a start saw, for the health route while the container is not ready. */
  #last;
  /** How the container this object started ended, when it did: what `monitor` told. */
  #exit;
  /** The start whose `monitor` may set `#exit`: an earlier container's end is not this one's. */
  #started;

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
      return problem(503, `the company's container did not start: ${error?.message ?? error}`, this.#exit);
    }
    if (health) return this.health();
    const headers = new Headers(request.headers);
    // The port's fetch reaches the container whatever the URL's host, which becomes the request's
    // Host header: the one asked for, so the company serves the public site declared on it.
    headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
    const forwarded = new Request(new URL(url.pathname + url.search, `http://${url.host}`), {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      ...(body && { duplex: "half" }),
    });
    try {
      return await this.ctx.container.getTcpPort(this.port).fetch(forwarded);
    } catch (error) {
      // Stopped since it started (it crashed, or Cloudflare stopped it): the next request starts it again.
      this.#ready = false;
      return problem(503, `the company's container did not answer: ${error?.message ?? error}`);
    }
  }

  /** What the Worker runs, and whether its container does. */
  health() {
    return json(200, {
      revision: this.env.SANOMA_REVISION ?? "",
      running: this.ctx.container.running,
      ready: this.#ready,
      ...(this.#last !== undefined && !this.#ready && { last: this.#last }),
      ...(this.#exit !== undefined && { exit: this.#exit }),
    });
  }

  /** Starts the container at the Worker's revision and image unless it runs them and answered; one start at a time. */
  ensureRunning() {
    if (this.#ready && this.ctx.container.running) return Promise.resolve();
    this.#starting ??= this.#start().finally(() => (this.#starting = undefined));
    return this.#starting;
  }

  async #start() {
    this.#ready = false;
    this.#exit = undefined;
    const container = this.ctx.container;
    const image = container.images?.[IMAGE];
    // Not one to retry: the Worker was uploaded without its image.
    if (!image) throw new Error(`the Worker names no "${IMAGE}" image among its containers' images`);
    const labels = { revision: this.env.SANOMA_REVISION ?? "", image: await imageLabel(image) };
    const until = Date.now() + START_TIMEOUT_MS;
    let last;
    const saw = (what) => (last = this.#last = what);
    let wait = POLL_MS;
    let checked = false;
    while (Date.now() < until) {
      if (this.#exit) {
        // Right after the application is made, the platform may not have assigned it to the
        // namespace yet: that start fails and is tried again. Any other end is the answer, as a
        // container that ended is not started again and again. Outside the try: a try's failure
        // is what one try saw, and would otherwise swallow this.
        if (!this.#exit.includes("no container application assigned")) {
          throw new Error(`${this.#exit} before answering /healthz on port ${this.port} (${last})`);
        }
        saw(this.#exit);
        this.#exit = undefined;
      }
      try {
        if (!checked && container.running) {
          // One running from before: kept only if it says it started at these (a deploy otherwise).
          const info = await container.inspect();
          const same = info && info.labels?.revision === labels.revision && (info.labels?.image ?? "") === labels.image;
          if (!same) await container.destroy("a new revision or image");
        }
        checked = true;
        if (!container.running) {
          container.start({
            image,
            instance: INSTANCE_TYPE,
            env: containerEnv(this.env),
            enableInternet: true,
            labels,
          });
          // `start` returns once its options are checked: a start that fails later, or a container
          // that exits, is what `monitor` tells, and the next try reports it. Only this start's: an
          // earlier container's monitor may settle after this one started.
          this.#exit = undefined;
          const started = (this.#started = {});
          const ended = (how) => void (this.#started === started && (this.#exit = how));
          container.monitor?.().then(
            () => ended("the container exited"),
            (error) => ended(`the container failed: ${error?.message ?? error}`),
          );
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
        saw(`/healthz answered ${res.status}`);
      } catch (error) {
        // Not listening yet, or not yet free to start again after a destroy.
        saw(error?.message ?? String(error));
      }
      // Doubling to a second: a container that is slow to listen is not asked four times a second.
      await sleep(wait);
      wait = Math.min(wait * 2, MAX_POLL_MS);
    }
    const ended = this.#exit ? `; ${this.#exit}` : "";
    throw new Error(`no answer from /healthz on port ${this.port} in ${START_TIMEOUT_MS / 1000} s (${last}${ended})`);
  }

  /** `/__sanoma/wake`, with the company's `SANOMA_WAKEUP_TOKEN`: the wake this object holds. */
  async wake(request) {
    const token = this.env.SANOMA_WAKEUP_TOKEN;
    if (!token) return problem(404, "no wakeup here: SANOMA_WAKEUP_TOKEN is not among the host's secrets");
    if (!sameToken(request.headers.get("authorization") ?? "", `Bearer ${token}`)) {
      return problem(401, "the token is not this host's SANOMA_WAKEUP_TOKEN");
    }
    const storage = this.ctx.storage;
    if (request.method === "GET") return json(200, (await storage.get(WAKE_KEY)) ?? { at: null });
    if (request.method === "DELETE") {
      await storage.delete(WAKE_KEY);
      await storage.deleteAlarm();
      return new Response(null, { status: 204 });
    }
    if (request.method !== "PUT") return problem(405, "GET, PUT or DELETE");
    const wake = parseRegistration(await request.json().catch(() => undefined));
    if (!wake) return problem(400, "the body must be { at: an ISO 8601 time }");
    // Whatever it held is replaced: a wake that rings for an older one starts a worker with nothing to do.
    await storage.put(WAKE_KEY, wake);
    await storage.setAlarm(Date.parse(wake.at));
    return new Response(null, { status: 204 });
  }

  /** The wake is due: start the container and send it `/wake`, then note when. A throw makes Cloudflare retry the alarm. */
  async alarm() {
    const wake = await this.ctx.storage.get(WAKE_KEY);
    if (!wake) return;
    await this.ensureRunning();
    const res = await this.ctx.container.getTcpPort(this.port).fetch("http://container/wake");
    await res.body?.cancel();
    if (!res.ok) {
      console.error(`GET /wake answered ${res.status}`);
      throw new Error(`the container answered /wake with ${res.status}`);
    }
    // When it rang, which a GET shows: unless another wake replaced it meanwhile.
    const held = await this.ctx.storage.get(WAKE_KEY);
    if (held?.at === wake.at) await this.ctx.storage.put(WAKE_KEY, { ...held, rang: new Date().toISOString() });
  }
}

/** The Worker's default export: every request goes to the one object. */
export const worker = {
  fetch: (request, env) => env[NAMESPACE].getByName("instance").fetch(request),
};
