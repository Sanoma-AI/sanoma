import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bluesky } from "@sanoma-ai/connector-bluesky";
import { ghost } from "@sanoma-ai/connector-ghost";
import { resend } from "@sanoma-ai/connector-resend";
import { ensureBuilt, testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import {
  memoryLedger,
  type ResolvedConfig,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  startWorker,
  type Worker,
} from "@sanoma-ai/workflows";
import { readPeople } from "@sanoma-ai/workflows/describe";
import { demoState } from "@sanoma-ai/workflows/scenarios";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import announce from "../../workflows/test/fixtures/announce.ts";
import { outbound } from "../../workflows/test/fixtures/outbound/resources/data.ts";
import outboundNext from "../../workflows/test/fixtures/outbound/workflows/outbound-next.ts";
import { type App, startApp } from "../src/index.ts";
import { ApiError } from "../src/api.ts";
import { DEMO_COOKIE, demoLogin } from "../src/login/demo.ts";
import { DEMO_REFUSED, notInDemo } from "../src/middleware.ts";

// Needs Postgres (`pnpm db:up`) and the built app (built when stale). A demo, as `sanoma demo`
// runs it: the worker and `startApp({ demo: true })` on one resolution with `fakes: "instance"`,
// the world and a moment seeded as the app starts, the demo login and the banner.

const appDir = fileURLToPath(new URL("..", import.meta.url));

// The outbound fixture with its people, a world and a moment: Mara's review of the launch copy.
const root = mkdtempSync(join(tmpdir(), "sanoma-demo-"));
cpSync(fileURLToPath(new URL("../../workflows/test/fixtures/outbound/", import.meta.url)), root, { recursive: true });
const files: Record<string, string> = {
  "resources/people.ts": `import { sanoma } from "sanoma/resources";

export const leon = sanoma.person({ id: "leon", name: "Leon" });
export const mara = sanoma.person({ id: "marketing-lead", name: "Mara" });
`,
  "scenarios/world.feature": `Feature: The world

  Scenario: Acme's pipeline
    Given data.outbound "Acme" has
      | contact | ada@acme.test |
      | stage   | researched    |
      | owner   | leon          |
`,
  "scenarios/moments.feature": `Feature: Moments

  @moment(marketing-lead,/inbox)
  Scenario: The launch copy waits for review
    When announce runs with
      | title    | Acme Pro             |
      | launchAt | 2030-01-01T09:00:00Z |
`,
};
for (const [path, text] of Object.entries(files)) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

const config: SanomaConfig = {
  workflows: [announce, outboundNext],
  connectors: [ghost, resend, bluesky],
  collections: [outbound],
  root,
  databaseUrl: testDatabaseUrl("app_demo"),
  ledger: memoryLedger(),
  demo: { start: "https://sanoma.example/start?apps=crm" },
};

let resolved: ResolvedConfig;
let worker: Worker;
let app: App;
let client: SanomaClient;

beforeAll(async () => {
  ensureBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
  resolved = resolveConfig(config, { fakes: "instance" });
  worker = await startWorker(config, { resolved, promote: true, quiet: true, schedules: false });
  app = await startApp(config, { demo: true, resolved, port: 0, host: "0.0.0.0" });
  client = await SanomaClient.connect(config, { resolved });
}, 120_000);

afterAll(async () => {
  try {
    await client?.close();
    await app?.close();
  } finally {
    await worker?.stop();
    await resolved?.dataStore?.close();
  }
});

/** A page as the demo serves it, with `cookie`, not following a redirect. */
const get = (path: string, cookie?: string) =>
  // Joined, not resolved: `//host/` stays a path of the demo's.
  fetch(`${app.url.replace("localhost", "127.0.0.1")}${path}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });

describe("the demo login", () => {
  const login = demoLogin(() => readPeople(root).people);

  it("runs only in a demo", async () => {
    expect(() => login.check("127.0.0.1")).toThrow("runs only in a demo");
    expect(() => login.check("0.0.0.0", { demo: true })).not.toThrow();
    await expect(startApp(config, { login, resolved })).rejects.toThrow("runs only in a demo");
  });

  const as = (cookie?: string) =>
    login.resolveActor(new Request("http://demo.test/inbox", { headers: cookie ? { cookie } : {} }));

  it("is the person the cookie names, else the first declared", async () => {
    expect(await as()).toEqual({ id: "leon" });
    expect(await as(`${DEMO_COOKIE}=marketing-lead`)).toEqual({ id: "marketing-lead" });
    expect(await as(`${DEMO_COOKIE}=nobody`)).toEqual({ id: "leon" });
  });
});

describe("startApp({ demo: true })", () => {
  it("opens a moment's URL as its person, with the moment waiting in their Inbox", async () => {
    const [moment] = demoState(resolved)!.moments;
    expect(moment).toMatchObject({ person: "marketing-lead", path: "/inbox" });
    await waitFor(async () => (await client.run(moment!.runId))?.status === "waiting");

    // `/<path>?as=<person>` keeps the person in the cookie and goes on to the path.
    const entered = await get(`${moment!.path}?as=${moment!.person}`);
    expect(entered.status).toBe(303);
    expect(entered.headers.get("location")).toBe("/inbox");
    const cookie = entered.headers.get("set-cookie")!.split(";")[0]!;
    expect(cookie).toBe(`${DEMO_COOKIE}=marketing-lead`);

    const inbox = await get("/inbox", cookie);
    expect(inbox.status).toBe(200);
    const html = (await inbox.text()).replaceAll("<!-- -->", "");
    // Waiting for Mara, on her For you.
    expect(html).toContain("Review launch copy");
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>For you<span[^>]*>1<\/span>/);
    // The banner: who you are, that nothing is kept, the way out; no Chat and no Go live.
    expect(html).toContain('aria-label="Demo"');
    expect(html).toMatch(/You are<button[^>]*>Mara/);
    expect(html).toContain("nothing you do here is saved");
    expect(html).toContain('href="https://sanoma.example/start?apps=crm"');
    expect(html).toContain('href="/inbox"');
    expect(html).not.toContain(">Chat</button>");
    expect(html).not.toContain('href="/setup"');
  });

  it("seeds the world into the instance", async () => {
    const rows = (await client.call("data.outbound.list", {}, { actor: "leon" })) as { key: string }[];
    expect(rows.map((r) => r.key)).toEqual(["Acme"]);
  });

  it("refuses an id nobody has, never redirects off the demo, and serves no agent and no Go live", async () => {
    const nobody = await get("/inbox?as=nobody");
    expect(nobody.status).toBe(404);
    expect(await nobody.text()).toContain("This demo has nobody called nobody");
    const elsewhere = await get("//evil.test/?as=leon");
    expect(elsewhere.headers.get("location")).toBe("/evil.test/");
    for (const path of ["/setup", "/setup/connect", "/setup/github/manifest", "/SETUP", "/%73etup/connect"]) {
      expect((await get(path)).status, path).toBe(404);
    }
    const chat = await fetch(new URL("/api/chat", app.url.replace("localhost", "127.0.0.1")), {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.url.replace("localhost", "127.0.0.1") },
      body: "{}",
    });
    expect(chat.status).toBe(404);
  });
});

describe("the server functions a demo refuses", () => {
  const server = notInDemo.options.server as unknown as (options: {
    next: () => unknown;
    context: { app: { demo?: object } };
    serverFnMeta: { name: string };
  }) => unknown;
  const call = (name: string, demo?: object) =>
    server({ next: () => "answered", context: { app: { demo } }, serverFnMeta: { name } });

  it("are those whose effect would outlast the reseed: a 403 there, and answered elsewhere", () => {
    const functions = readFileSync(new URL("../src/functions.ts", import.meta.url), "utf8");
    for (const name of DEMO_REFUSED) {
      expect(functions, name).toContain(`export const ${name} = createServerFn`);
      expect(() => call(name, {})).toThrow(ApiError);
      expect(call(name)).toBe("answered");
    }
    for (const name of ["startRunFn", "decideFn", "callFn", "getConfig"]) expect(call(name, {})).toBe("answered");
  });
});
