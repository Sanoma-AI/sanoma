import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, request, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { totalmem } from "node:os";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { errorMessage, type SanomaConfig } from "@sanoma-ai/workflows";
import { parse, serialize } from "cookie-es";
import { escapeIdentifier, Pool } from "pg";
import { UsageError } from "./config.ts";
import type { SanomaEvent } from "./events.ts";
import { cliFile, type Served } from "./serve.ts";

/*
 * `sanoma demo`'s session host (the config's `demo.sessions`): each visitor gets a copy of a
 * seeded database and a process of their own over it, so a moment waits for them alone and
 * nothing they type reaches another. The host runs no worker and no app itself: it keeps the seed
 * (`<database>_seed`, which no process ever serves, as Postgres copies only a database nobody is
 * connected to), copies it per visitor, runs `sanoma serve` over each copy as a child (exactly the
 * code that seeded it), and forwards each request by the visitor's cookie. Past the cap, visitors
 * share one demo instance on `<database>` itself.
 */

/** The cookie naming a visitor's session: its token, or `SHARED` for the shared instance. */
export const SESSION_COOKIE = "sanoma_demo_session";

/** The session cookie's value for a visitor sent to the shared instance, past the cap. */
const SHARED = "shared";

/** How many sessions wait ready for the next visitors, within the cap. */
const WARM = 2;

/** The config's `demo` defaults: minutes a session lives unused, minutes between seeds. */
const IDLE_MINUTES = 30;
const RESEED_MINUTES = 60;

/**
 * What a session costs at most, for the cap `sessions: true` reads: a worker and an app in one
 * process (85–180 MB measured, up to 340 MB after many pages in the S1 spike), and Postgres's
 * connections, its pools at `POOL_SIZE` (5 while it starts and serves, 2–3 idle; 11–14 unlowered).
 */
const SESSION_BYTES = 340 * 1024 * 1024;
const SESSION_CONNECTIONS = 6;

/** Each child's pools, its DBOS system pool among them, at most this big (`SANOMA_POOL_SIZE`). */
const POOL_SIZE = "3";

/** How long a child has to listen (the seed's may build the sites first), and to stop, before it is killed. */
const START_MS = 180_000;
const STOP_MS = 15_000;

/** Postgres's longest name, in bytes, and the longest the host adds to the demo's: a session's `_s_<id>`. */
const MAX_NAME = 63;
const LONGEST_SUFFIX = "_s_00000000".length;

/** One process of the host's: `sanoma serve` as a demo, listening at `url` on this machine. */
interface Child {
  url: string;
  /** Resolves when the process has exited, stopped or not. */
  exited: Promise<void>;
  /** Whether it has exited. */
  ended(): boolean;
  stop(): Promise<void>;
}

/**
 * A visitor's session: its id (its copy's name ends with it), its cookie's `token`, never shown
 * elsewhere (an id in a log is no way in), its copy of the seed, the child over it, and when it was last asked.
 */
interface Session {
  id: string;
  token: string;
  database: string;
  child: Child;
  seen: number;
}

export interface DemoHostOptions {
  /** The host's port: 0 for any free port. */
  port: number;
  /** Where it listens. Default 127.0.0.1. */
  host?: string;
  /** The demo's database: the seed and the sessions' copies are beside it, the shared instance on it. */
  databaseUrl: string;
  log: (line: string) => void;
}

/**
 * Starts the session host: sessions an earlier host left dropped, the seed built
 * (`<database>_seed_next`, seeded by a child with the world and the moments, then renamed in),
 * then the listener. A visitor without a session takes a warm one (or one made then), up to the
 * cap; past it, the shared instance (started on first use). A session unused for `demo.idle`
 * minutes is stopped and dropped; every `demo.reseed` minutes the seed is built afresh, the warm
 * sessions made again from it and the live ones left as they are. `stop` stops every child and
 * drops every session.
 */
export async function startDemoHost(config: SanomaConfig, options: DemoHostOptions): Promise<Served> {
  const { log } = options;
  const base = new URL(options.databaseUrl);
  const name = decodeURIComponent(base.pathname.slice(1));
  const seed = `${name}_seed`;
  const next = `${name}_seed_next`;
  /** The last seed, while the next is renamed in: put back if that fails. */
  const old = `${name}_seed_old`;
  if (Buffer.byteLength(name) + LONGEST_SUFFIX > MAX_NAME) {
    throw new UsageError(
      `The demo's database "${name}" has too long a name for its sessions' beside it: at most ${MAX_NAME - LONGEST_SUFFIX} bytes`,
    );
  }
  const urlOf = (database: string) => {
    const url = new URL(base);
    url.pathname = `/${encodeURIComponent(database)}`;
    return url.toString();
  };
  const cwd = config.file ? dirname(config.file) : (config.root ?? process.cwd());
  const idleMs = (config.demo?.idle ?? IDLE_MINUTES) * 60_000;
  const reseedMs = (config.demo?.reseed ?? RESEED_MINUTES) * 60_000;

  // As the runtime makes a database: through the server's `postgres` database.
  // Two: a session's copy dropped while the next is copied.
  const admin = new Pool({ connectionString: urlOf("postgres"), max: 2 });
  admin.on("error", (err) => log(`demo host: a Postgres connection failed: ${errorMessage(err)}`));
  const sql = (text: string, values?: unknown[]) => admin.query(text, values);
  const drop = (database: string) => sql(`DROP DATABASE IF EXISTS ${escapeIdentifier(database)} WITH (FORCE)`);
  const rename = (from: string, to: string) =>
    sql(`ALTER DATABASE ${escapeIdentifier(from)} RENAME TO ${escapeIdentifier(to)}`);

  // The copies and the swap of the seed, one at a time: Postgres copies or renames only a
  // database nobody is connected to, and a copy holds a connection to the seed while it runs.
  let queue = Promise.resolve();
  const onSeed = <T>(step: () => Promise<T>): Promise<T> => {
    const done = queue.then(step);
    queue = done.then(
      () => {},
      () => {},
    );
    return done;
  };

  // A clone where Postgres 18 and the file system have one (APFS, XFS, Btrfs); else the default,
  // for good once a clone fails where the default copy then works.
  let clone = Number((await sql("SHOW server_version_num")).rows[0].server_version_num) >= 180_000;
  const copy = (database: string) =>
    onSeed(async () => {
      const create = `CREATE DATABASE ${escapeIdentifier(database)} TEMPLATE ${escapeIdentifier(seed)}`;
      if (!clone) return void (await sql(create));
      const conn = await admin.connect();
      let failed: Error | undefined;
      try {
        await conn.query("SET file_copy_method = clone");
        await conn.query(`${create} STRATEGY FILE_COPY`);
      } catch (err) {
        failed = err instanceof Error ? err : new Error(String(err));
      } finally {
        // A connection whose clone failed is not kept, nor its setting.
        conn.release(failed);
      }
      if (!failed) return;
      await sql(create);
      clone = false;
      log(`demo host: copying the seed by the default strategy, since a clone failed: ${errorMessage(failed)}`);
    });

  /** `sanoma serve` as a demo over `database`: `kind` `instance` (the seed's, the shared one) or `copy` (a session's). */
  async function startChild(kind: "instance" | "copy", database: string, label: string): Promise<Child> {
    const child = spawn(process.execPath, [cliFile(), "serve"], {
      cwd,
      env: {
        ...process.env,
        SANOMA_DEMO: kind,
        SANOMA_DATABASE_URL: urlOf(database),
        SANOMA_APP_HOST: "127.0.0.1",
        SANOMA_APP_PORT: "0",
        SANOMA_EVENTS: "1",
        SANOMA_POOL_SIZE: POOL_SIZE,
      },
      // A process group of its own, so a terminal's ctrl-c reaches the host alone, which stops it;
      // stdin a pipe, whose end stops it (`SANOMA_EVENTS`), the host's exit among them.
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    const ended = () => child.exitCode !== null || child.signalCode !== null;
    // The whole group: what the child started besides (a build of the sites) with it.
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // The group is gone already.
      }
    };
    // A child that has exited closes its stdin: the host's end of it then fails, to no one's harm.
    child.stdin!.on("error", () => {});
    createInterface({ input: child.stderr! }).on("line", (line) => log(`${label}: ${line}`));
    const url = await new Promise<string>((ready, failed) => {
      setTimeout(() => failed(new Error(`${label} did not listen within ${START_MS / 1000} s`)), START_MS).unref();
      createInterface({ input: child.stdout! }).on("line", (line) => {
        // Beside the lines a person reads, each event is a line of its own (`events.ts`).
        if (!line.startsWith('{"sanoma":1,')) return;
        let event: SanomaEvent;
        try {
          event = JSON.parse(line) as SanomaEvent;
        } catch {
          return;
        }
        if (event.event === "ready") ready(event.url);
        if (event.event === "error") failed(new Error(`${label} could not start: ${event.message}`));
      });
      child.once("error", failed);
      void exited.then(() => failed(new Error(`${label} exited before it listened`)));
    }).catch((err: unknown) => {
      kill();
      throw err;
    });
    let stopping: Promise<void> | undefined;
    return {
      url,
      exited,
      ended,
      stop: () =>
        (stopping ??= (async () => {
          if (ended()) return;
          child.stdin!.end();
          const timer = setTimeout(kill, STOP_MS);
          await exited;
          clearTimeout(timer);
        })()),
    };
  }

  /**
   * The seed built afresh: `next` seeded by an instance over it (which makes it, as the runtime
   * makes any database, with the world and the moments, which it waits for before it listens),
   * stopped, and renamed in place of the last.
   */
  async function seedAfresh(): Promise<void> {
    await drop(next);
    await (await startChild("instance", next, "demo seed")).stop();
    await onSeed(async () => {
      // A connection of the stopped process's may still be closing: ended, waiting up to 5 s for each.
      await sql("SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE datname = $1", [next]);
      // The last seed set aside, not dropped, until the next is in its place.
      await drop(old);
      const had = Boolean((await sql("SELECT 1 FROM pg_database WHERE datname = $1", [seed])).rowCount);
      if (had) await rename(seed, old);
      try {
        await rename(next, seed);
      } catch (err) {
        if (had) await rename(old, seed);
        throw err;
      }
      await drop(old);
    });
  }

  let cap: number;
  try {
    // Sessions an earlier host left, stopped before it dropped them: nothing of a session outlives it.
    for (const { datname } of (await sql("SELECT datname FROM pg_database")).rows as { datname: string }[]) {
      if (datname.startsWith(`${name}_s_`) && /^[0-9a-f]{8}$/.test(datname.slice(name.length + 3))) await drop(datname);
    }
    await seedAfresh();
    cap = config.demo?.sessions === true ? await defaultCap() : Number(config.demo?.sessions);
  } catch (err) {
    await drop(next).catch(() => {});
    await admin.end();
    throw err;
  }
  log(`demo host: a session per visitor, at most ${cap} at once, each a copy of ${seed}`);

  /** `sessions: true`'s cap: as many sessions as the memory and Postgres's free connections hold, at least one. */
  async function defaultCap(): Promise<number> {
    // No limit reads 0, or on some systems a number as big as a 64-bit integer allows.
    const memory = Math.min(process.constrainedMemory() || Infinity, totalmem());
    const { rows } = await sql(
      "SELECT current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int" +
        " - count(*)::int AS free FROM pg_stat_activity",
    );
    // Two processes besides the sessions': the seed's, and the shared instance's.
    const byConnections = Math.floor((rows[0].free as number) / SESSION_CONNECTIONS) - 2;
    return Math.max(1, Math.min(Math.floor((memory * 0.75) / SESSION_BYTES), byConnections));
  }

  const live = new Map<string, Session>();
  let warm: Promise<Session | undefined>[] = [];
  /** The sessions that count toward the cap: from when one is made until it has ended. */
  let count = 0;
  /** What is under way besides the warm sessions' start (a visitor's `take`, a session ending, a seed), which `stop` waits for. */
  const pending = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
    return work;
  };
  let shared: Promise<Child> | undefined;
  let closed = false;
  const room = () => cap - count;

  /** A session: a copy of the seed, and a child over it. One whose child exits is live no more. */
  async function make(): Promise<Session> {
    count++;
    const id = randomBytes(4).toString("hex");
    const database = `${name}_s_${id}`;
    let child: Child;
    try {
      await copy(database);
      child = await startChild("copy", database, `demo session ${id}`);
    } catch (err) {
      await drop(database).catch(() => {});
      count--;
      throw err;
    }
    const session = { id, token: randomBytes(24).toString("base64url"), database, child, seen: Date.now() };
    // A warm one that exits is found out when it is taken (`take`).
    void child.exited.then(() => {
      if (live.get(session.token) !== session) return;
      live.delete(session.token);
      log(`demo host: session ${id} exited`);
      retire(session);
    });
    return session;
  }

  /** Warm sessions made, while the cap leaves room. */
  function refill(): void {
    if (closed) return;
    while (warm.length < WARM && room() > 0) {
      warm.push(
        make().catch((err: unknown) => {
          log(`demo host: a session could not start: ${errorMessage(err)}`);
          return undefined;
        }),
      );
    }
  }

  /**
   * A session for a new visitor: a warm one, else one made now, within the cap; else none, and
   * none when one failed to start (the visitor goes to the shared instance this time).
   */
  async function take(): Promise<Session | undefined> {
    for (;;) {
      const ready =
        warm.shift() ??
        (room() > 0
          ? make().catch((err: unknown) => void log(`demo host: a session could not start: ${errorMessage(err)}`))
          : undefined);
      if (!ready) return undefined;
      refill();
      const session = await ready;
      if (!session || closed) return void (session && retire(session));
      if (!session.child.ended()) {
        session.seen = Date.now();
        live.set(session.token, session);
        log(`demo host: session ${session.id} taken (${live.size} of ${cap})`);
        return session;
      }
      // A warm one that has exited since: the next, or one made now.
      retire(session);
    }
  }

  /** A session stopped and its copy dropped, counted toward the cap until then. */
  async function end(session: Session): Promise<void> {
    try {
      await session.child.stop();
      await drop(session.database);
    } finally {
      count--;
    }
  }

  /** A session no visitor has (any more) ended, then the warm ones made again. */
  function retire(session: Session): void {
    void track(
      end(session)
        .catch((err: unknown) => log(`demo host: session ${session.id} could not be dropped: ${errorMessage(err)}`))
        .finally(refill),
    );
  }

  const sweep = setInterval(
    () => {
      for (const session of live.values()) {
        if (Date.now() - session.seen < idleMs) continue;
        live.delete(session.token);
        log(`demo host: session ${session.id} idle, dropped`);
        retire(session);
      }
    },
    Math.min(Math.max(idleMs / 4, 250), 60_000),
  ).unref();

  // The next seed `reseedMs` after the last one ended.
  let reseedTimer: NodeJS.Timeout | undefined;
  const scheduleReseed = () => {
    reseedTimer = setTimeout(() => {
      void track(
        (async () => {
          await seedAfresh();
          log(`demo host: ${seed} seeded afresh`);
          // The warm sessions are copies of the last seed: made again from this one.
          const stale = warm;
          warm = [];
          for (const ready of stale) void track(ready.then((session) => session && retire(session)));
          refill();
        })()
          .catch((err: unknown) => log(`demo host: the seed could not be built afresh: ${errorMessage(err)}`))
          .finally(() => {
            if (!closed) scheduleReseed();
          }),
      );
    }, reseedMs).unref();
  };
  scheduleReseed();

  /** The shared instance, past the cap: one demo on the database itself, seeded as any, started again once it exits. */
  const sharedInstance = () => {
    if (closed) return Promise.reject(new Error("the demo host is stopping"));
    if (shared) return shared;
    const starting = startChild("instance", name, "demo shared");
    shared = starting;
    const forget = () => {
      if (shared === starting) shared = undefined;
    };
    void starting.then((child) => child.exited.then(forget), forget);
    return starting;
  };

  const server = createServer((req, res) => {
    answer(req, res).catch((err: unknown) => {
      log(`demo host: a request failed: ${errorMessage(err)}`);
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end("The demo could not start: try again in a moment.\n");
      }
    });
  });

  /** A request sent on to its session's child, or to a session taken for it (the cookie set), or to the shared instance. */
  async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return void res.end("ok\n");
    }
    const kept = parse(req.headers.cookie ?? "")[SESSION_COOKIE];
    const session = kept === undefined ? undefined : live.get(kept);
    if (session) {
      session.seen = Date.now();
      return forward(req, res, session.child.url);
    }
    // A visitor of the shared instance gets a session of their own once there is room again.
    const taken = await track(take());
    const url = taken?.child.url ?? (await sharedInstance()).url;
    const value = taken?.token ?? SHARED;
    return forward(req, res, url, value === kept ? undefined : sessionCookie(req, value));
  }

  refill();
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(options.port, options.host ?? "127.0.0.1", () => {
      server.off("error", fail);
      done();
    });
  });
  const { address, family, port } = server.address() as AddressInfo;
  const host = address === "0.0.0.0" || address === "::" ? "localhost" : family === "IPv6" ? `[${address}]` : address;
  return {
    url: `http://${host}:${port}`,
    sites: {},
    async stop() {
      closed = true;
      clearInterval(sweep);
      clearTimeout(reseedTimer);
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
      // Until nothing is under way: what ends may set another session ending.
      while (pending.size) await Promise.allSettled(pending);
      const sessions = [...live.values(), ...(await Promise.all(warm)).filter((s) => s !== undefined)];
      live.clear();
      warm = [];
      try {
        const ended = await Promise.allSettled([...sessions.map(end), shared?.then((child) => child.stop())]);
        for (const result of ended) if (result.status === "rejected") log(`demo host: ${errorMessage(result.reason)}`);
      } finally {
        await admin.end();
      }
    },
  };
}

/** The session cookie for `value`: for this browser's visit, Lax as the demo login's, Secure behind TLS. */
const sessionCookie = (req: IncomingMessage, value: string) =>
  serialize(SESSION_COOKIE, value, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: req.headers["x-forwarded-proto"] === "https",
  });

/** `req` sent on to the child at `url` as it came, and its answer back, with `cookie` set besides its own. */
async function forward(req: IncomingMessage, res: ServerResponse, url: string, cookie?: string): Promise<void> {
  const target = new URL(url);
  const upstream = request({
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: req.url,
    headers: req.headers,
  });
  // The body sent on as the answer comes: a child may answer (and close) before it has read it all.
  pipeline(req, upstream).catch(() => {});
  const [answer] = (await once(upstream, "response")) as [IncomingMessage];
  const headers = { ...answer.headers };
  if (cookie) headers["set-cookie"] = [...(answer.headers["set-cookie"] ?? []), cookie];
  res.writeHead(answer.statusCode ?? 502, headers);
  await pipeline(answer, res);
}
