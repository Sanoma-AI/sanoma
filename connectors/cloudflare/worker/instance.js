// The company's Worker script without the platform: its fetch handler (`serve`) and its Durable
// Object (`Instance`). `index.js` binds them to `cloudflare:workers` and to the app bundle the
// deploy uploaded under `app/`; the connector's fake runs this file in Node over a stubbed `ctx`,
// so both kits check the code Cloudflare runs. No imports, so Node loads it as it is.
//
// The Worker script is the app: every request but the object's own routes and `/wake` goes to the
// app bundle's fetch, with the visitor's address from `cf-connecting-ip` and the object's
// `startNow` as its host. The object runs the company's worker in its container (`ctx.container`),
// never a visitor's request: it starts it at the Worker's `SANOMA_REVISION` and the image its upload
// names (`ctx.container.images.runtime`, as the `durable_object` scheduling policy has it), drains
// and replaces one running at another (a deploy's restart), holds the company's one wake as an
// alarm, and answers three routes: its health, its wake, and the app bundle the worker builds,
// pulled from the container's port with the instance token. It never stops the container: the
// worker exits once it is idle, and the container ends with it; the next start or wake starts it.

/** The object's route that holds the company's wake, with the instance token. */
export const WAKE_PATH = "/__sanoma/wake";
/** The object's route that answers what the Worker runs; with `?start=1` and the instance token, it starts the container at it. */
export const HEALTH_PATH = "/__sanoma/health";
/** The worker port's route of the app bundle at `?revision=`, which the object passes on with the instance token (`APP_BUNDLE_PATH` in `sanoma/workflows/shared`). */
export const APP_BUNDLE_PATH = "/__sanoma/app-bundle";
/** The Host contract's wake: the Worker has the worker started now (a wakeup's `GET {url}/wake`). */
const HOST_WAKE_PATH = "/wake";
/**
 * The header on every answer of the object: the id of the Worker version that answered (its
 * `VERSION_METADATA`'s), so a deploy tells its own upload's answers from an earlier version's, and
 * the object's answers from anyone else's.
 */
export const DEPLOYMENT_HEADER = "x-sanoma-deployment";
/** The header the app reads the visitor's address from (`CLIENT_IP_HEADER` in `sanoma/workflows`). */
export const CLIENT_IP_HEADER = "x-sanoma-client-ip";
/**
 * How long Cloudflare keeps the container running after the object's last request: its maximum,
 * six hours (`setInactivityTimeout` takes more than 0 and at most 21,600,000 ms, and rejects
 * above), so it rarely decides. The worker ends the container itself, by exiting once it is idle;
 * work inside the container is no request to the object, so a shorter timeout would cut a long
 * run. A run busy longer than this with no request to the object is stopped by the platform's
 * SIGTERM, and the worker registers its wake as it stops, so the next container resumes it.
 * Without one set, Cloudflare stops it shortly after the object goes quiet.
 */
export const INACTIVITY_MS = 6 * 60 * 60 * 1000;

/** Sets the container's inactivity timeout (`INACTIVITY_MS`): a safety net, so a refusal is logged, never a failed start. */
async function keepRunning(container) {
  try {
    await container.setInactivityTimeout(INACTIVITY_MS);
  } catch (error) {
    console.error(`setting the container's inactivity timeout failed: ${error?.message ?? error}`);
  }
}
/** The Worker version's metadata binding (`version_metadata`): its `id`, which each upload answers with. */
export const VERSION_METADATA = "CF_VERSION_METADATA";
/** The binding that names the object, in the Worker's env. */
export const NAMESPACE = "SANOMA_INSTANCE";
/** The name the upload gives the runtime image (`containers[].images`), which the object starts. */
export const IMAGE = "runtime";
/** How long a start may take to answer `/healthz`: the image pulled, the source cloned and installed. */
const START_TIMEOUT_MS = 10 * 60 * 1000;
/** How long a drained worker has to stop on its own before its container is destroyed. */
const DRAIN_MS = 30 * 1000;
/** SIGTERM: the worker's own stop (it stops dequeuing, closes and exits). */
const SIGTERM = 15;
/** How long one try of a starting container's `/healthz` may take. */
const TRY_MS = 5_000;
/** How long between two tries of a starting container's `/healthz`, doubling to `MAX_POLL_MS`. */
const POLL_MS = 250;
const MAX_POLL_MS = 1_000;
/** Where the wake is kept, in the object's storage. */
const WAKE_KEY = "wake";
/** Where a start `startNow` asked for is kept until the alarm that makes it rings. */
const START_KEY = "start";
/**
 * The retries of an alarm whose start keeps failing before that start is given up, so the wake
 * held for later is set again: Cloudflare retries an alarm that throws up to six times, then drops it.
 */
const START_RETRIES = 5;
/** The container's size, one of the named types `start` takes: ½ vCPU, 4 GiB (`basic`, ¼ vCPU, is refused under this policy). */
const INSTANCE_TYPE = "standard-1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A refusal; with `exit`, how the container ended: a deploy stops waiting on it. */
const problem = (status, error, exit) => json(status, { error, ...(exit !== undefined && { exit }) });

/** The Worker's text bindings (plain text and secrets): the container's environment. */
function containerEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string"));
}

/** A label of a value too long for one (a label holds 64 bytes; a pinned image is longer): a digest of it. */
export async function digestLabel(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
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
  /** The start in progress, which every caller waits on. */
  #starting;
  /** True once a container this object started (or found) answered `/healthz`, until it ends. */
  #ready = false;
  /** What the last try of a start saw, for the health route while the container is not ready. */
  #last;
  /** How the container this object started ended, when it did: what `monitor` told. */
  #exit;
  /**
   * The start whose `monitor` is heard, `answered` once its container did: an earlier container's
   * end is not this one's.
   */
  #started;
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // An object that restarts (a deploy) starts without the timeout, though its container runs.
    const container = ctx.container;
    if (container?.running) void ctx.blockConcurrencyWhile(() => keepRunning(container));
  }

  get port() {
    return Number(this.env.PORT);
  }

  /** The object's routes, each answer marked with this version's id (`DEPLOYMENT_HEADER`). */
  async fetch(request) {
    const answer = await this.#answer(request);
    // A copy: the headers of the container's own answer cannot be changed.
    const marked = new Response(answer.body, answer);
    marked.headers.set(DEPLOYMENT_HEADER, this.env[VERSION_METADATA]?.id ?? "");
    return marked;
  }

  /** Never a visitor's request, which the app answers on the Worker. */
  async #answer(request) {
    const url = new URL(request.url);
    if (url.pathname === WAKE_PATH) return this.wake(request);
    if (url.pathname === HEALTH_PATH && !url.searchParams.has("start")) return this.health(200);
    if (url.pathname !== HEALTH_PATH && url.pathname !== APP_BUNDLE_PATH) {
      return problem(404, `the object answers ${WAKE_PATH}, ${HEALTH_PATH} and ${APP_BUNDLE_PATH} alone`);
    }
    const refused = this.#refuse(request);
    if (refused) return refused;
    // A container that started and ended is the answer: asking again would only start it again.
    // Told once: the next ask starts it again.
    const exit = this.#starting ? undefined : this.#exit;
    if (exit) {
      this.#exit = undefined;
      return problem(503, `the company's container did not start: ${exit}`, exit);
    }
    if (!this.#ready || !this.ctx.container.running) {
      // Started from an alarm, which outlives this request (the caller may be the worker this
      // start drains): the caller asks again until it is ready. One already under way is not asked again.
      if (!this.#starting) await this.startNow();
      return url.pathname === HEALTH_PATH ? this.health(202) : json(202, { starting: true });
    }
    if (url.pathname === HEALTH_PATH) return this.health(200);
    // The worker builds the bundle at the revision asked for, in a checkout of its own.
    try {
      return await this.ctx.container.getTcpPort(this.port).fetch(`http://container${url.pathname}${url.search}`, {
        headers: { authorization: `Bearer ${this.env.SANOMA_WAKEUP_TOKEN}` },
      });
    } catch (error) {
      // Stopped since it answered (Cloudflare's own stop, a crash): the next ask starts it again.
      this.#ready = false;
      return problem(503, `the company's container did not answer: ${error?.message ?? error}`);
    }
  }

  /** Why a request without the company's instance token is refused, if it is. */
  #refuse(request) {
    const token = this.env.SANOMA_WAKEUP_TOKEN;
    if (!token) return problem(404, "no instance token here: SANOMA_WAKEUP_TOKEN is not among the host's secrets");
    if (!sameToken(request.headers.get("authorization") ?? "", `Bearer ${token}`)) {
      return problem(401, "the token is not this host's SANOMA_WAKEUP_TOKEN");
    }
    return undefined;
  }

  /** What the Worker runs, and whether its container does and answered at it. */
  health(status) {
    return json(status, {
      revision: this.env.SANOMA_REVISION ?? "",
      ...(this.env.SANOMA_CONFIG_REVISION && { configurationRevision: this.env.SANOMA_CONFIG_REVISION }),
      running: this.ctx.container.running,
      ready: this.#ready && this.ctx.container.running,
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
    // An earlier container's end, told while this start makes its own, is none of this one's.
    this.#started = undefined;
    const container = this.ctx.container;
    const image = container.images?.[IMAGE];
    // Not one to retry: the Worker was uploaded without its image.
    if (!image) throw new Error(`the Worker names no "${IMAGE}" image among its containers' images`);
    const labels = {
      revision: this.env.SANOMA_REVISION ?? "",
      image: await digestLabel(image),
      ...(this.env.SANOMA_CONFIG_REVISION && { configuration: this.env.SANOMA_CONFIG_REVISION }),
      // The sites' domains, which the worker's environment, and the bundles it builds, name.
      ...(this.env.SANOMA_DOMAINS && { domains: await digestLabel(this.env.SANOMA_DOMAINS) }),
    };
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
          // One running from before: kept only if it says it started at these; else the deploy's
          // restart, its worker drained first, so it stops dequeuing before its container goes.
          const info = await container.inspect();
          const same =
            info &&
            info.labels?.revision === labels.revision &&
            (info.labels?.image ?? "") === labels.image &&
            (info.labels?.configuration ?? "") === (labels.configuration ?? "") &&
            (info.labels?.domains ?? "") === (labels.domains ?? "");
          if (!same) await this.#replace(container);
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
          // earlier container's monitor may settle after this one started. One that answered and
          // then ended (its worker exited, idle; a crash; Cloudflare's own stop) is stopped, not a
          // start that failed: the next ask or wake starts it again.
          this.#exit = undefined;
          const started = (this.#started = { answered: false });
          const ended = (how) => {
            if (this.#started !== started) return;
            if (started.answered) this.#ready = false;
            else this.#exit = how;
          };
          container.monitor?.().then(
            () => ended("the container exited"),
            (error) => ended(`the container failed: ${error?.message ?? error}`),
          );
        }
        // A try of its own time: a hung one would hold every caller past the deadline.
        const res = await container
          .getTcpPort(this.port)
          .fetch("http://container/healthz", { signal: AbortSignal.timeout(TRY_MS) });
        await res.body?.cancel();
        if (res.ok) {
          await keepRunning(container);
          this.#ready = true;
          // A container kept from before has no start of this one's to mark.
          if (this.#started) this.#started.answered = true;
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
    throw new Error(
      `still starting after ${START_TIMEOUT_MS / 1000} s: no answer from /healthz on port ${this.port} (${last}${ended})`,
    );
  }

  /** Drains the running container's worker (SIGTERM: its own stop), then destroys what is left of it. */
  async #replace(container) {
    container.signal(SIGTERM);
    const until = Date.now() + DRAIN_MS;
    while (container.running && Date.now() < until) await sleep(POLL_MS);
    if (container.running) await container.destroy("a new revision, image, configuration or domains");
  }

  /** `/__sanoma/wake`, with the company's `SANOMA_WAKEUP_TOKEN`: the wake this object holds. */
  async wake(request) {
    const refused = this.#refuse(request);
    if (refused) return refused;
    const storage = this.ctx.storage;
    if (request.method === "GET") return json(200, (await storage.get(WAKE_KEY)) ?? { at: null });
    // A start `startNow` asked for keeps its alarm, which sets the wake's once it rang.
    const starting = Boolean(await storage.get(START_KEY));
    if (request.method === "DELETE") {
      await storage.delete(WAKE_KEY);
      if (!starting) await storage.deleteAlarm();
      return new Response(null, { status: 204 });
    }
    if (request.method !== "PUT") return problem(405, "GET, PUT or DELETE");
    const wake = parseRegistration(await request.json().catch(() => undefined));
    if (!wake) return problem(400, "the body must be { at: an ISO 8601 time }");
    // Whatever it held is replaced: a wake that rings for an older one starts a worker with nothing to do.
    await storage.put(WAKE_KEY, wake);
    if (starting) await alarmBy(storage, Date.parse(wake.at));
    else await storage.setAlarm(Date.parse(wake.at));
    return new Response(null, { status: 204 });
  }

  /**
   * Starts the container soon and sends it `/wake`, without waiting for it: a run was queued for
   * it (the app's call over RPC), a wake came, or a deploy asks for its bundle or its restart. An
   * alarm now, which outlives the request that asked, makes the start; a wake held for later is set
   * again once it is made.
   */
  async startNow() {
    const storage = this.ctx.storage;
    await storage.put(START_KEY, true);
    await alarmBy(storage, Date.now());
  }

  /**
   * A start `startNow` asked for, then the wake if it is due: start the container and send it
   * `/wake` (once for both), then note when the wake rang. A wake not due yet is set again. A throw
   * makes Cloudflare retry the alarm; a start that still fails after `START_RETRIES` is given up,
   * the wake kept.
   */
  async alarm(info) {
    const storage = this.ctx.storage;
    let woke = false;
    if (await storage.get(START_KEY)) {
      try {
        await this.#wakeContainer();
        woke = true;
      } catch (error) {
        if ((info?.retryCount ?? 0) < START_RETRIES) throw error;
        console.error(`starting the container for a queued run failed: ${error?.message ?? error}`);
      }
      await storage.delete(START_KEY);
    }
    const wake = await storage.get(WAKE_KEY);
    if (!wake || wake.rang) return;
    const at = Date.parse(wake.at);
    if (at > Date.now()) return storage.setAlarm(at);
    if (!woke) await this.#wakeContainer();
    // When it rang, which a GET shows: unless another wake replaced it meanwhile.
    const held = await storage.get(WAKE_KEY);
    if (held?.at === wake.at) await storage.put(WAKE_KEY, { ...held, rang: new Date().toISOString() });
  }

  /**
   * Starts the container unless it runs, then sends it `/wake`: a container that is up may hold a
   * worker that is stopping, which the wake keeps up. A worker that already decided to exit has
   * closed its port: the wake fails, and the alarm's retry starts a fresh container once it ended.
   */
  async #wakeContainer() {
    await this.ensureRunning();
    let res;
    try {
      res = await this.ctx.container.getTcpPort(this.port).fetch("http://container/wake");
    } catch (error) {
      this.#ready = false;
      throw error;
    }
    await res.body?.cancel();
    if (!res.ok) {
      console.error(`GET /wake answered ${res.status}`);
      throw new Error(`the container answered /wake with ${res.status}`);
    }
  }
}

/** Sets the object's alarm to ring by `at`: an alarm set to ring sooner is left as it is. */
async function alarmBy(storage, at) {
  const set = await storage.getAlarm();
  if (set === null || set > at) await storage.setAlarm(at);
}

/** The Worker's one object. */
const instanceOf = (env) => env[NAMESPACE].getByName("instance");

/**
 * The Worker script's fetch: the object's routes to the object, the Host contract's `/wake` as a
 * start now, and everything else to the app bundle (`loadApp`, imported on the first request, so
 * the object's isolate never evaluates it), its visitor's address set from Cloudflare's
 * `cf-connecting-ip`, a client's own copy overwritten: the one trust decision the app relies on.
 */
export async function serve(request, env, ctx, loadApp) {
  const url = new URL(request.url);
  const object = instanceOf(env);
  if (url.pathname === WAKE_PATH || url.pathname === HEALTH_PATH || url.pathname === APP_BUNDLE_PATH) {
    return object.fetch(request);
  }
  if (url.pathname === HOST_WAKE_PATH && request.method === "GET") {
    await object.startNow();
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
  const headers = new Headers(request.headers);
  headers.set(CLIENT_IP_HEADER, request.headers.get("cf-connecting-ip") ?? "");
  const { default: app } = await loadApp();
  // The object's stub is the app's host: its `startNow` over RPC.
  return app.fetch(new Request(request, { headers }), env, ctx, object);
}
