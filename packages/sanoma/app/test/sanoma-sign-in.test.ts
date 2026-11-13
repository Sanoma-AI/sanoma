import { createHash } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { SanomaClient } from "sanoma/workflows";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../src/context.ts";
import { sanomaCallback, sanomaSignIn, startSanomaSignIn } from "../src/server/sanoma-sign-in.ts";

// Signing in to Sanoma from Hosting, against a Cloud of msw handlers and a client whose secrets
// are a map: the `/connect` URL (state, S256 challenge, a loopback return), then the callback,
// which redeems the code with the verifier once and stores the Cloud token as the person who
// started it. Refused: another state, an expired sign-in, a replayed callback, a hosted company,
// an answer that is no Cloud token, a token the environment sets. No token, code or verifier in a
// response or a log.

const CLOUD = "https://cloud.sanoma.test";
const TOKEN = "sca_SENTINEL-token";
const CODE = "SENTINEL-code";
const ORIGIN = "http://localhost:4300";

/** What the Cloud's redeem was sent, each time. */
const redeemed: { code: string; verifier: string }[] = [];
/** How the Cloud answers a redeem. */
let answer: () => Response = () => HttpResponse.json({ token: TOKEN });
const cloud = setupServer(
  http.post(`${CLOUD}/api/token/redeem`, async ({ request }) => {
    redeemed.push((await request.json()) as { code: string; verifier: string });
    return answer();
  }),
);

/** The company's secrets, and whether a write of the Cloud token is refused as the environment's. */
let stored: Map<string, { value: string; setBy: string }>;
let readOnly = false;
let clearFails = false;
const client = {
  secrets: async (names: readonly string[]) =>
    new Map(
      names.flatMap((name) => {
        const row = stored.get(name);
        return row ? [[name, { value: row.value, source: "stored" as const, setBy: row.setBy, setAt: "now" }]] : [];
      }),
    ),
  setSecret: async (name: string, value: string, { by }: { by: string }) => {
    if (readOnly && name === "SANOMA_CLOUD_TOKEN") throw Object.assign(new Error("read only"), { code: "read_only" });
    stored.set(name, { value, setBy: by });
  },
  clearSecret: async (name: string) => {
    if (clearFails) throw new Error("the store is down");
    stored.delete(name);
  },
} as unknown as SanomaClient;

const app = (place: AppContext["place"] = "this-computer") =>
  ({
    client,
    place,
    snapshot: { description: { name: "Acme Ops", resources: [] }, infra: null, bound: [] },
  }) as unknown as AppContext;
const alice = { id: "alice" };

/** Everything logged while the tests ran. */
let logged: unknown[][] = [];

beforeAll(() => cloud.listen());
afterAll(() => cloud.close());
beforeEach(() => {
  // Where the Cloud driver reads it: the process's environment.
  vi.stubEnv("SANOMA_CLOUD_URL", CLOUD);
  stored = new Map();
  readOnly = false;
  clearFails = false;
  redeemed.length = 0;
  answer = () => HttpResponse.json({ token: TOKEN });
  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args));
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Nothing secret in any log.
  const text = JSON.stringify(logged);
  const leaked = [TOKEN, CODE, ...redeemed.map((r) => r.verifier)].filter((value) => text.includes(value));
  if (leaked.length) throw new Error(`A secret was logged: ${leaked.length} of them`);
});

/** Starts a sign-in, as Hosting does, and what the `/connect` URL carries. */
async function started(address?: string) {
  const { url } = await startSanomaSignIn(app(), alice, ORIGIN, address ? { address } : {});
  return new URL(url);
}

/** The callback, as the browser comes back from the Cloud with `params`. */
const callback = (params: Record<string, string>) =>
  sanomaCallback(app(), new Request(`http://127.0.0.1:4300/hosting/sanoma/callback?${new URLSearchParams(params)}`));

/** A callback's page, and what it must never show. */
async function page(res: Response) {
  const text = await res.text();
  for (const value of [TOKEN, CODE, ...redeemed.map((r) => r.verifier)]) expect(text).not.toContain(value);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return text;
}

describe("signing in to Sanoma", () => {
  it("opens the Cloud's /connect with a state, the verifier's S256 challenge, a loopback return, the company and its address", async () => {
    const url = await started();
    expect(url.origin + url.pathname).toBe(`${CLOUD}/connect`);
    expect(url.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("challenge")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("challenge_method")).toBe("S256");
    expect(url.searchParams.get("return")).toBe("http://127.0.0.1:4300/hosting/sanoma/callback");
    expect(url.searchParams.get("company")).toBe("Acme Ops");
    // No host declared: an address made of the company's name; else the one the person typed.
    expect(url.searchParams.get("repository")).toBe("acme-ops");
    expect((await started("acme")).searchParams.get("repository")).toBe("acme");
    expect(await sanomaSignIn(app())).toEqual({ signedIn: false, pending: true });
  });

  it("is for the app on a computer: a hosted company has its token", async () => {
    await expect(startSanomaSignIn(app("live"), alice, ORIGIN)).rejects.toMatchObject({
      status: 409,
      body: { error: "Signing in to Sanoma is for the app on a computer: a hosted company has its token" },
    });
  });

  it("comes back to a loopback address only", async () => {
    await expect(startSanomaSignIn(app(), alice, "https://acme.example")).rejects.toMatchObject({
      status: 409,
      body: { error: "Signing in to Sanoma comes back to this app at a loopback address only" },
    });
    expect(await sanomaSignIn(app())).toEqual({ signedIn: false, pending: false });
  });

  it("answers a failure of its own with a page that is not cached", async () => {
    const url = await started();
    clearFails = true;
    const res = await callback({ code: CODE, state: url.searchParams.get("state")! });
    expect(res.status).toBe(500);
    expect(await page(res)).toContain("Signing in to Sanoma failed");
    expect(redeemed).toEqual([]);
  });

  it("redeems the code with the verifier once, and stores the Cloud token as who started it, never showing it", async () => {
    const url = await started();
    const res = await callback({ code: CODE, state: url.searchParams.get("state")! });
    expect(res.status).toBe(200);
    expect(await page(res)).toContain("Signed in to Sanoma");
    expect(redeemed).toEqual([{ code: CODE, verifier: expect.any(String) }]);
    // The verifier is the one the challenge was made of.
    const challenge = createHash("sha256").update(redeemed[0]!.verifier).digest("base64url");
    expect(challenge).toBe(url.searchParams.get("challenge"));
    expect(stored.get("SANOMA_CLOUD_TOKEN")).toEqual({ value: TOKEN, setBy: "alice" });
    const status = await sanomaSignIn(app());
    expect(status).toEqual({ signedIn: true, pending: false, source: "stored", setBy: "alice", setAt: "now" });
    expect(JSON.stringify(status)).not.toContain(TOKEN);

    // A replay finds no sign-in: the Cloud is not asked again.
    const again = await callback({ code: CODE, state: url.searchParams.get("state")! });
    expect(again.status).toBe(400);
    expect(await page(again)).toContain("This sign-in is not the app&#39;s");
    expect(redeemed).toHaveLength(1);
  });

  it("refuses another state, and keeps the sign-in for its own", async () => {
    const url = await started();
    const res = await callback({ code: CODE, state: "another-state" });
    expect(res.status).toBe(400);
    await page(res);
    expect(redeemed).toEqual([]);
    expect(await sanomaSignIn(app())).toMatchObject({ signedIn: false, pending: true });
    // A second sign-in replaces the first: the first one's state is no longer the app's.
    const second = await started();
    expect((await callback({ code: CODE, state: url.searchParams.get("state")! })).status).toBe(400);
    expect((await callback({ code: CODE, state: second.searchParams.get("state")! })).status).toBe(200);
  });

  it("refuses a sign-in after ten minutes, asking the Cloud nothing", async () => {
    const url = await started();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000 + 1);
    expect(await sanomaSignIn(app())).toEqual({ signedIn: false, pending: false });
    const res = await callback({ code: CODE, state: url.searchParams.get("state")! });
    expect(res.status).toBe(400);
    await page(res);
    expect(redeemed).toEqual([]);
  });

  it("says a code the Cloud has spent or let expire has expired, and stores nothing", async () => {
    answer = () => HttpResponse.json({ error: "gone" }, { status: 410 });
    const url = await started();
    const res = await callback({ code: CODE, state: url.searchParams.get("state")! });
    expect(res.status).toBe(410);
    expect(await page(res)).toContain("This sign-in has expired");
    expect(stored.has("SANOMA_CLOUD_TOKEN")).toBe(false);
  });

  it("stores no answer that is not a Cloud token, and logs only the status", async () => {
    answer = () => HttpResponse.json({ token: "ghp_SENTINEL-not-cloud" });
    const url = await started();
    const res = await callback({ code: CODE, state: url.searchParams.get("state")! });
    expect(res.status).toBe(502);
    expect(await page(res)).toContain("Sanoma did not answer with a Cloud token");
    expect(stored.has("SANOMA_CLOUD_TOKEN")).toBe(false);
    expect(JSON.stringify(logged)).toContain("Sanoma answered 200 to the sign-in, with no Cloud token");
    expect(JSON.stringify(logged)).not.toContain("SENTINEL-not-cloud");
  });

  it("says signing in was cancelled when the Cloud sends an error, and drops the sign-in", async () => {
    const url = await started();
    const res = await callback({ error: "access_denied", state: url.searchParams.get("state")! });
    expect(res.status).toBe(400);
    expect(await page(res)).toContain("Signing in was cancelled");
    expect(redeemed).toEqual([]);
    expect(await sanomaSignIn(app())).toEqual({ signedIn: false, pending: false });
  });

  it("says the token is set elsewhere when the environment sets it, which the app cannot change", async () => {
    readOnly = true;
    const url = await started();
    const res = await callback({ code: CODE, state: url.searchParams.get("state")! });
    expect(res.status).toBe(409);
    expect(await page(res)).toContain("The Cloud token is set elsewhere");
  });
});
