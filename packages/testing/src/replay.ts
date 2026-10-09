import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { bypass, http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";

/** One request and the vendor's reply. A fixture, `<name>.json`, is a list of them, in order. */
export interface Exchange {
  method: string;
  /** The URL's path and query, decoded; the host is not compared. */
  path: string;
  status: number;
  /** Rate-limit headers only. */
  headers?: Record<string, string>;
  body: unknown;
}

/** A request a test made, its body parsed. */
export interface Sent {
  method: string;
  path: string;
  headers: Headers;
  body: any;
}

/** `SANOMA_LIVE=1` calls the vendor instead of replaying; `SANOMA_RECORD=1` with it rewrites the fixtures. */
export const live = process.env.SANOMA_LIVE === "1";
export const recording = live && process.env.SANOMA_RECORD === "1";

export interface ReplayOptions {
  /** The fixtures' directory: `new URL("./fixtures/", import.meta.url)`. */
  fixtures: URL;
  /** Live, the variables a run needs: it fails at once without them. */
  needs: string[];
  /** Replaying, the variables each test starts with. */
  env: Record<string, string>;
  /** Takes out of a recording what the repo must not hold: ids, addresses, keys. */
  scrub: (exchanges: Exchange[]) => Exchange[];
  /** Fills a fixture's placeholders from the request it answers, before the two are compared. */
  fill?: (exchange: Exchange, sent: Sent) => Exchange;
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text || null;
  }
};

/**
 * Replays a vendor's recorded replies with msw, for the test file that calls it: each test
 * `play`s a fixture, whose exchanges must be the requests it makes, in order. Live, the same
 * tests call the vendor, and recording, `play(name)` saves the test's exchanges as `name`.
 */
export function replay({ fixtures, needs, env, scrub, fill = (e) => e }: ReplayOptions) {
  const server = setupServer();
  const sent: Sent[] = [];
  const exchanges: Exchange[] = [];
  const stray: string[] = [];
  let queue: Exchange[] = [];
  let saveAs: string | undefined;
  const fixture = (name: string): Exchange[] => JSON.parse(readFileSync(new URL(`${name}.json`, fixtures), "utf8"));

  /** Answers the test's requests with `exchanges` (by default the fixture `name`), in order. */
  function play(name: string, given?: Exchange[]) {
    if (!live) queue = [...(given ?? fixture(name))];
    if (recording) saveAs = name;
    server.use(
      http.all("*", async ({ request }) => {
        const url = new URL(request.url);
        const path = decodeURIComponent(url.pathname + url.search);
        const req: Sent = {
          method: request.method,
          path,
          headers: request.headers,
          body: parse(await request.clone().text()),
        };
        sent.push(req);
        if (live) {
          const res = await fetch(bypass(request));
          const text = await res.text();
          const kept = Object.fromEntries([...res.headers].filter(([k]) => /^(ratelimit-|retry-after$)/.test(k)));
          const headers = Object.keys(kept).length > 0 ? { headers: kept } : {};
          exchanges.push({ method: req.method, path, status: res.status, ...headers, body: parse(text) });
          // `fetch` decoded the body: the reply must no longer say it is compressed.
          const forward = new Headers(res.headers);
          for (const header of ["content-encoding", "content-length"]) forward.delete(header);
          return new HttpResponse(text, { status: res.status, headers: forward });
        }
        const next = queue[0] && fill(queue[0], req);
        if (next?.method !== req.method || next.path !== path) {
          stray.push(`not in the fixture: ${req.method} ${path}`);
          return HttpResponse.json({ message: `not in the fixture: ${req.method} ${path}` }, { status: 400 });
        }
        queue.shift();
        exchanges.push(next);
        const init = { status: next.status, headers: next.headers };
        const { body } = next;
        return typeof body === "string" || body === null ? new HttpResponse(body, init) : HttpResponse.json(body, init);
      }),
    );
  }

  beforeAll(() => {
    const missing = needs.filter((name) => !process.env[name]);
    if (live && missing.length) throw new Error(`SANOMA_LIVE=1 needs ${missing.join(", ")}`);
    server.listen({ onUnhandledFrame: live ? "bypass" : "error" });
  });
  beforeEach(() => {
    if (!live) for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  });
  afterEach(() => {
    if (saveAs) {
      mkdirSync(fixtures, { recursive: true });
      writeFileSync(new URL(`${saveAs}.json`, fixtures), `${JSON.stringify(scrub(exchanges), null, 2)}\n`);
    }
    const differences = [...stray, ...queue.map((e) => `not made: ${e.method} ${e.path}`)];
    [sent.length, exchanges.length, stray.length, queue, saveAs] = [0, 0, 0, [], undefined];
    server.resetHandlers();
    vi.unstubAllEnvs();
    if (differences.length) throw new Error(`the requests differ from the fixture:\n${differences.join("\n")}`);
  });
  afterAll(() => server.close());

  return { server, play, fixture, sent, exchanges };
}
