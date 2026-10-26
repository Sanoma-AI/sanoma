import { testDatabaseUrl } from "@sanoma-ai/testing";
import { Client, escapeIdentifier, Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  startWakeupService,
  WAKEUP_ACCOUNTS_TABLE,
  WAKEUP_INSTANCES_TABLE,
  type WakeupService,
} from "../src/wakeup-service.ts";

const databaseUrl = testDatabaseUrl("wakeup_service");
const pool = new Pool({ connectionString: databaseUrl });

/** Drops the test's database, so the service's first start makes it and its tables. */
beforeAll(async () => {
  const url = new URL(databaseUrl);
  const name = decodeURI(url.pathname.slice(1));
  url.pathname = "/postgres";
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});
afterAll(() => pool.end());

/** What the fake `fetch` was called with, and how it answers: 204 unless a test says otherwise. */
let calls: string[] = [];
let answer: (url: string, signal: AbortSignal) => Promise<Response> = async () => new Response(null, { status: 204 });
const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push(url);
  return answer(url, init!.signal!);
}) as typeof globalThis.fetch;

/** The clock: real time, unless a test freezes it. */
let clock: (() => Date) | undefined;
const lines: { level: "info" | "warn"; line: string }[] = [];

let service: WakeupService | undefined;

async function start(): Promise<WakeupService> {
  service = await startWakeupService({
    databaseUrl,
    fetch,
    now: () => clock?.() ?? new Date(),
    log: { info: (line) => lines.push({ level: "info", line }), warn: (line) => lines.push({ level: "warn", line }) },
  });
  return service;
}

afterEach(async () => {
  await service?.stop();
  service = undefined;
  calls = [];
  answer = async () => new Response(null, { status: 204 });
  clock = undefined;
  lines.length = 0;
  await pool.query(`TRUNCATE ${WAKEUP_INSTANCES_TABLE}, ${WAKEUP_ACCOUNTS_TABLE}`).catch(() => undefined);
});

/** A request to the service's one route. */
async function send(
  method: string,
  path: string,
  { token, body }: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: unknown; headers: Headers }> {
  const request = new Request(`http://wakeup.test${path}`, {
    method,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const [route] = service!.routes;
  const res = await route!.handle(request);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined, headers: res.headers };
}

/** An account and one instance of it at `url`. */
async function instance(url = "http://instance.test/base/") {
  const account = await service!.mintAccount("acme");
  const made = await send("POST", "/wakeup/instances", { token: account.token, body: { url } });
  expect(made.status).toBe(201);
  const { id, token } = made.json as { id: string; token: string };
  return { account, id, token };
}

const wake = (id: string, token: string, at: Date | string, generation: number) =>
  send("PUT", `/wakeup/instances/${id}/wake`, {
    token,
    body: { at: typeof at === "string" ? at : at.toISOString(), generation },
  });

/** A request's status, after checking it is not cached. */
const status = async (...args: Parameters<typeof send>) => {
  const res = await send(...args);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return res.status;
};

const ago = (ms: number) => new Date(Date.now() - ms);
const later = (ms: number) => new Date(Date.now() + ms);
/** `s` seconds after the frozen clock's start. */
const plus = (s: number) => new Date(Date.parse("2030-01-01T00:00:00.000Z") + s * 1000);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("startWakeupService", () => {
  it("makes its database and its two tables when missing, and starts again over them", async () => {
    await start();
    const { rows } = await pool.query("SELECT to_regclass($1)::text AS accounts, to_regclass($2)::text AS instances", [
      WAKEUP_ACCOUNTS_TABLE,
      WAKEUP_INSTANCES_TABLE,
    ]);
    expect(rows).toEqual([{ accounts: WAKEUP_ACCOUNTS_TABLE, instances: WAKEUP_INSTANCES_TABLE }]);
    await service!.stop();
    await start();
  });

  it("mints accounts and instances, keeping only their tokens' hashes, and shows an instance to its account", async () => {
    await start();
    const { account, id, token } = await instance();
    expect(account.token).toMatch(/^swa_[A-Za-z0-9_-]{43}$/);
    expect(token).toMatch(/^swi_[A-Za-z0-9_-]{43}$/);
    const stored = await pool.query(
      `SELECT a.token_hash AS account, a.label, i.token_hash AS instance, i.url FROM ${WAKEUP_INSTANCES_TABLE} i ` +
        `JOIN ${WAKEUP_ACCOUNTS_TABLE} a ON a.id = i.account_id`,
    );
    expect(stored.rows).toEqual([
      {
        account: expect.stringMatching(/^[0-9a-f]{64}$/),
        label: "acme",
        instance: expect.stringMatching(/^[0-9a-f]{64}$/),
        url: "http://instance.test/base",
      },
    ]);
    expect(JSON.stringify(stored.rows)).not.toContain(token.slice(4));
    const shown = await send("GET", `/wakeup/instances/${id}`, { token: account.token });
    expect(shown).toMatchObject({
      status: 200,
      json: {
        id,
        url: "http://instance.test/base",
        at: null,
        generation: 0,
        calledAt: null,
        attempts: 0,
        lastError: null,
      },
    });
    expect(shown.headers.get("cache-control")).toBe("no-store");
    expect(shown.headers.get("content-type")).toBe("application/json; charset=utf-8");
    await expect(service!.mintAccount(" ")).rejects.toThrow("An account's label must not be empty");
  });

  it("refuses a missing or unknown token, another's instance, an unknown id or path, and another method", async () => {
    await start();
    const mine = await instance();
    const theirs = await instance("https://other.test");
    const unknown = "00000000-0000-4000-8000-000000000000";
    const url = { url: "http://x.test" };
    expect(await status("POST", "/wakeup/instances", { body: url })).toBe(401);
    expect(await status("POST", "/wakeup/instances", { token: "swa_nope", body: url })).toBe(401);
    expect(await status("POST", "/wakeup/instances", { token: mine.token, body: url })).toBe(401);
    expect(await status("GET", `/wakeup/instances/${mine.id}`)).toBe(401);
    expect(await status("GET", `/wakeup/instances/${mine.id}`, { token: mine.token })).toBe(401);
    expect(await status("GET", `/wakeup/instances/${theirs.id}`, { token: mine.account.token })).toBe(403);
    expect(await status("DELETE", `/wakeup/instances/${theirs.id}`, { token: mine.account.token })).toBe(403);
    expect(await status("GET", `/wakeup/instances/${unknown}`, { token: mine.account.token })).toBe(404);
    expect(await status("GET", "/wakeup/instances/nope", { token: mine.account.token })).toBe(404);
    expect(await status("GET", "/wakeup/elsewhere", { token: mine.account.token })).toBe(404);
    expect(await status("GET", "/wakeup/instances", { token: mine.account.token })).toBe(405);
    expect(await status("POST", `/wakeup/instances/${mine.id}/wake`, { token: mine.token })).toBe(405);
    const at = later(60_000);
    expect((await wake(mine.id, mine.account.token, at, 1)).status).toBe(401);
    expect((await wake(mine.id, "swi_nope", at, 1)).status).toBe(401);
    expect((await wake(mine.id, theirs.token, at, 1)).status).toBe(403);
    expect((await wake(unknown, mine.token, at, 1)).status).toBe(403);
    // Deleted: its token is no instance's, and its account finds nothing.
    expect(await status("DELETE", `/wakeup/instances/${mine.id}`, { token: mine.account.token })).toBe(204);
    expect(await status("GET", `/wakeup/instances/${mine.id}`, { token: mine.account.token })).toBe(404);
    expect((await wake(mine.id, mine.token, at, 1)).status).toBe(401);
    // Revoked: neither the account's token nor its instances' is taken.
    await service!.revokeAccount(theirs.account.id);
    expect(await status("GET", `/wakeup/instances/${theirs.id}`, { token: theirs.account.token })).toBe(401);
    expect((await wake(theirs.id, theirs.token, at, 1)).status).toBe(401);
  });

  it("takes an http(s) URL with no user, query or fragment, kept without its trailing slash", async () => {
    await start();
    const { token } = await service!.mintAccount("acme");
    const register = (url: unknown) => send("POST", "/wakeup/instances", { token, body: { url } });
    for (const bad of [
      "ftp://x.test",
      "http://user:pass@x.test",
      "http://user@x.test",
      "http://x.test/?a=1",
      "http://x.test/?",
      "http://x.test/#here",
      "x.test",
      "",
      42,
      undefined,
    ]) {
      expect(await register(bad), String(bad)).toMatchObject({
        status: 400,
        json: { error: "url must be an http(s) URL with no user, password, query or fragment" },
      });
    }
    expect((await send("POST", "/wakeup/instances", { token, body: "not json" })).status).toBe(400);
    for (const [given, kept] of [
      ["https://x.test", "https://x.test"],
      ["https://x.test/", "https://x.test"],
      ["http://x.test:8080/a/b/", "http://x.test:8080/a/b"],
    ]) {
      const { json } = await register(given);
      const { rows } = await pool.query(`SELECT url FROM ${WAKEUP_INSTANCES_TABLE} WHERE id = $1`, [
        (json as { id: string }).id,
      ]);
      expect(rows).toEqual([{ url: kept }]);
    }
  });

  it("takes a registration only with a newer generation, answering 204 either way, and refuses a bad one", async () => {
    await start();
    const { account, id, token } = await instance();
    const first = later(3_600_000);
    expect((await wake(id, token, first, 2)).status).toBe(204);
    // Older, and equal: nothing changes.
    expect((await wake(id, token, later(60_000), 1)).status).toBe(204);
    expect((await wake(id, token, later(60_000), 2)).status).toBe(204);
    const shown = async () => (await send("GET", `/wakeup/instances/${id}`, { token: account.token })).json;
    expect(await shown()).toMatchObject({ at: first.toISOString(), generation: 2 });
    for (const body of [
      { at: "soon", generation: 3 },
      { generation: 3 },
      { at: first.toISOString(), generation: -1 },
      { at: first.toISOString(), generation: 1.5 },
      { at: first.toISOString(), generation: "3" },
      [],
    ]) {
      const res = await send("PUT", `/wakeup/instances/${id}/wake`, { token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await shown()).toMatchObject({ at: first.toISOString(), generation: 2 });
  });

  it("calls a due instance once, with its generation, as soon as a registration wakes the loop", async () => {
    await start();
    // Nothing waits: the loop sleeps its longest, which only the registration cuts short.
    await pause(200);
    const { account, id, token } = await instance();
    expect((await wake(id, token, ago(1_000), 3)).status).toBe(204);
    await vi.waitFor(() => expect(calls).toEqual(["http://instance.test/base/wake?generation=3"]), { timeout: 2_000 });
    await vi.waitFor(async () =>
      expect((await send("GET", `/wakeup/instances/${id}`, { token: account.token })).json).toMatchObject({
        calledAt: expect.any(String),
        attempts: 0,
        lastError: null,
      }),
    );
    // Woken again, by a registration that changes nothing: it is not called twice.
    expect((await wake(id, token, ago(1_000), 3)).status).toBe(204);
    await pause(300);
    expect(calls).toHaveLength(1);
    expect(lines).toEqual([{ level: "info", line: "wakeup: called http://instance.test/base/wake?generation=3" }]);
  });

  it("calls an instance when its time comes, not before, and not at a time it moved from", async () => {
    await start();
    const { id, token } = await instance();
    await wake(id, token, later(400), 1);
    // Moved later before it fires: the earlier time calls nothing.
    await wake(id, token, later(3_600_000), 2);
    await pause(800);
    expect(calls).toEqual([]);
    const other = await instance("http://soon.test");
    await wake(other.id, other.token, later(500), 1);
    await pause(200);
    expect(calls).toEqual([]);
    await vi.waitFor(() => expect(calls).toEqual(["http://soon.test/wake?generation=1"]), { timeout: 2_000 });
  });

  it("tries a failing instance again after min(2^attempts s, 5 min), for as long as it fails, never dropping it", async () => {
    let now = plus(0);
    clock = () => now;
    await start();
    const { account, id, token } = await instance();
    const failing: (() => Promise<Response>)[] = [
      async () => new Response("down", { status: 503 }),
      async () => {
        throw new Error("connection refused");
      },
    ];
    answer = async () => (failing.shift() ?? (async () => new Response(null, { status: 200 })))();
    const row = async () =>
      (await pool.query(`SELECT attempts, last_error, next_attempt_at, called_at FROM ${WAKEUP_INSTANCES_TABLE}`))
        .rows[0];
    /** The same registration again, which changes nothing and wakes the loop. */
    const poke = () => wake(id, token, plus(-1), 1);
    await poke();
    await vi.waitFor(async () => expect(await row()).toMatchObject({ attempts: 1, last_error: "answered 503" }));
    expect((await row()).next_attempt_at).toEqual(plus(1));
    // Not due until then, however often it is woken.
    await poke();
    await pause(300);
    expect(calls).toHaveLength(1);
    now = plus(1);
    await poke();
    await vi.waitFor(async () => expect(await row()).toMatchObject({ attempts: 2, last_error: "connection refused" }));
    expect((await row()).next_attempt_at).toEqual(plus(3));
    // Many failures later, the wait is at most five minutes.
    await pool.query(`UPDATE ${WAKEUP_INSTANCES_TABLE} SET attempts = 20`);
    failing.push(async () => new Response(null, { status: 500 }));
    now = plus(3);
    await poke();
    await vi.waitFor(async () => expect(await row()).toMatchObject({ attempts: 21, last_error: "answered 500" }));
    expect((await row()).next_attempt_at).toEqual(plus(303));
    now = plus(303);
    await poke();
    await vi.waitFor(async () =>
      expect(await row()).toMatchObject({ attempts: 0, last_error: null, called_at: plus(303) }),
    );
    expect(calls).toHaveLength(4);
    expect((await send("GET", `/wakeup/instances/${id}`, { token: account.token })).json).toMatchObject({
      calledAt: plus(303).toISOString(),
      attempts: 0,
    });
    expect(lines.map((l) => l.level)).toEqual(["warn", "warn", "warn", "info"]);
    expect(lines[0]!.line).toBe(
      "wakeup: calling http://instance.test/base/wake?generation=1 failed (answered 503); it is tried again",
    );
  });

  it("calls a newer registration made during a call, rather than counting the call as its", async () => {
    await start();
    const { id, token } = await instance();
    const release = Promise.withResolvers<void>();
    answer = async (url) => {
      if (url.endsWith("generation=1")) await release.promise;
      return new Response(null, { status: 204 });
    };
    await wake(id, token, ago(1_000), 1);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await wake(id, token, ago(500), 2);
    release.resolve();
    await vi.waitFor(() =>
      expect(calls).toEqual([
        "http://instance.test/base/wake?generation=1",
        "http://instance.test/base/wake?generation=2",
      ]),
    );
  });

  it("calls at most eight instances at once", async () => {
    await start();
    let inFlight = 0;
    let most = 0;
    answer = async () => {
      most = Math.max(most, ++inFlight);
      await pause(200);
      inFlight--;
      return new Response(null, { status: 204 });
    };
    const account = await service!.mintAccount("acme");
    for (let n = 0; n < 12; n++) {
      const made = await send("POST", "/wakeup/instances", {
        token: account.token,
        body: { url: `http://i${n}.test` },
      });
      const { id } = made.json as { id: string };
      // Due, unknown to the sleeping loop.
      await pool.query(`UPDATE ${WAKEUP_INSTANCES_TABLE} SET at = $2, generation = 1 WHERE id = $1`, [id, ago(1_000)]);
    }
    // One registration wakes the loop for all twelve.
    const last = await instance("http://i12.test");
    await wake(last.id, last.token, ago(1_000), 1);
    await vi.waitFor(() => expect(calls).toHaveLength(13), { timeout: 5_000 });
    expect(most).toBe(8);
  });

  it("stops at once, abandoning a call in flight, which stays due", async () => {
    await start();
    const { id, token } = await instance();
    answer = (_url, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    await wake(id, token, ago(1_000), 1);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const started = Date.now();
    await service!.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
    const { rows } = await pool.query(`SELECT called_at, attempts, last_error FROM ${WAKEUP_INSTANCES_TABLE}`);
    expect(rows).toEqual([{ called_at: null, attempts: 0, last_error: null }]);
    await expect(service!.mintAccount("late")).rejects.toThrow("Cannot use a pool after calling end on the pool");
    service = undefined;
  });
});
