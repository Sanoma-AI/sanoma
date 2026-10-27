import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureBuilt, testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import {
  defineConfig,
  defineConnector,
  type DriftReport,
  DriverError,
  jsonlLedger,
  memoryLedger,
  type Principal,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  type Source,
  startWorker,
  type Worker,
  withSetup,
} from "@sanoma-ai/workflows";
import { describeConfig, outlineWorkflow, svgDataUrl } from "@sanoma-ai/workflows/describe";
import { isNotFound } from "@tanstack/react-router";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { executablePath, launch as launchChrome } from "puppeteer-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import announce from "../../workflows/test/fixtures/announce.ts";
import { companyFakes } from "../../workflows/test/fixtures/company/fakes.ts";
import { outbound } from "../../workflows/test/fixtures/outbound/resources/data.ts";
import { marketingFakes } from "../../workflows/test/harness.ts";
import { z } from "zod";
import { type App, type IngressRoute, startApp } from "../src/index.ts";
import {
  ACTOR_HEADER,
  ACTOR_KEY,
  ApiError,
  ClearCredentialRequest,
  DecideCall,
  type ErrorResponse,
  RUNS_LIMIT,
  RunsQuery,
  SetCredentialRequest,
} from "../src/api.ts";
import type { AppContext, LoginProvider } from "../src/context.ts";
import { availableConnectors, JSDELIVR, NPM_REGISTRY } from "../src/server/available.ts";
import { databaseHost, loopbackLogin, placeOf } from "../src/loopback.ts";
import { admitting } from "../src/login/admission.ts";
import { barLabels, barLink } from "./bar-helpers.ts";
import {
  type ActorContext,
  actorOf,
  adopt,
  appConfig,
  asApiError,
  clearCredential,
  credentials,
  decide,
  fileSource,
  lastRuns,
  listRuns,
  nextFires,
  parse,
  readStartRun,
  requireActor,
  runDetail,
  saysWho,
  scenarios,
  serverFnFailure,
  signOutUrl,
  setCredential,
  startRun,
  validate,
  withoutSources,
} from "../src/server/core.ts";

// Needs Postgres (`pnpm db:up`) and the built app: the tests build it when
// dist/server/server.js is missing or older than a file under src/.
const appDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(appDir, "dist");

const HOLD_TITLE = "Publish the held post";

// The marketing vendors: live runs call these fakes.
const vendors = marketingFakes();
const blog = vendors.ghost;
// The workflows' company fixture: its data files, and GitHub and Stripe holding them as declared.
const company = companyFakes();
const companyDir = fileURLToPath(new URL("../../workflows/test/fixtures/company/", import.meta.url));
/**
 * The app's root, with no package.json (so the app is "sanoma"): its scenarios/ is a copy of the
 * fixtures' feature files (which a test breaks to see the app say so), its resources/ the company's
 * and the outbound fixture's collections.
 */
const appRoot = mkdtempSync(join(tmpdir(), "sanoma-app-"));

/**
 * npm, as the Connectors page reads it: the search for the keyword, and each package's latest
 * version by name; and jsDelivr's copies of their logo files. Ghost is installed; Acme is Sanoma's;
 * Widgets is the community's, its logo no SVG; the plain one has no `sanoma` field, the escaping
 * one a logo outside its package, and the gone one no version.
 */
const NPM_PACKAGES: Record<string, object> = {
  "@sanoma-ai/connector-ghost": { name: "@sanoma-ai/connector-ghost", version: "9.9.9", sanoma: { title: "Ghost" } },
  "sanoma-connector-widgets": {
    name: "sanoma-connector-widgets",
    version: "0.1.0",
    homepage: "http://widgets.example/code",
    sanoma: { title: "Widgets", logo: "logo.svg" },
  },
  "sanoma-connector-escaping": {
    name: "sanoma-connector-escaping",
    version: "1.0.0",
    sanoma: { title: "Escaping", logo: "../../logo.svg" },
  },
  "@sanoma-ai/connector-acme": {
    name: "@sanoma-ai/connector-acme",
    version: "1.2.0",
    description: "Acme's orders",
    homepage: "https://acme.example/code",
    sanoma: { title: "Acme", logo: "logo.svg", logoDark: "logo-dark.svg" },
  },
  "sanoma-connector-plain": { name: "sanoma-connector-plain", version: "1.0.0" },
};
const npm = setupServer(
  http.get(`${NPM_REGISTRY}/*`, ({ request }) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/-/v1/search") {
      const names = [...Object.keys(NPM_PACKAGES), "sanoma-connector-gone"];
      return HttpResponse.json({ objects: names.map((name) => ({ package: { name } })) });
    }
    const pkg = NPM_PACKAGES[decodeURIComponent(pathname.slice(1, -"/latest".length))];
    return pkg ? HttpResponse.json(pkg) : new HttpResponse(null, { status: 404 });
  }),
  http.get(`${JSDELIVR}/*`, ({ request }) => {
    const logo = NPM_LOGOS[new URL(request.url).pathname.slice("/npm/".length)];
    return logo ? HttpResponse.text(logo) : new HttpResponse(null, { status: 404 });
  }),
);
const ACME_LOGO = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
/** The logo files on jsDelivr, by `<package>@<version>/<path>`. */
const NPM_LOGOS: Record<string, string> = {
  "@sanoma-ai/connector-acme@1.2.0/logo.svg": ACME_LOGO,
  "@sanoma-ai/connector-acme@1.2.0/logo-dark.svg": ACME_LOGO.replace("<circle", '<circle fill="white"'),
  "sanoma-connector-widgets@0.1.0/logo.svg": "<img src=x onerror=alert(1)>",
};
/** npm's search failing with `reply`, for the rest of a test. */
const npmSearchFails = (reply: () => Response) => npm.use(http.get(`${NPM_REGISTRY}/-/v1/search`, reply));
const scenariosDir = join(appRoot, "scenarios");
cpSync(fileURLToPath(new URL("./fixtures/scenarios/", import.meta.url)), scenariosDir, { recursive: true });
cpSync(join(companyDir, "resources"), join(appRoot, "resources"), { recursive: true });
cpSync(
  fileURLToPath(new URL("../../workflows/test/fixtures/outbound/resources/data.ts", import.meta.url)),
  join(appRoot, "resources/data.ts"),
);
// Who may act here (`p<n>` in resources/people.ts), and the policy: a run "held" starts waits for
// marketing-lead before it publishes the post.
const PEOPLE = ["alice", "Ålice", "tester", "held", "marketing-lead", "someone-else"];
writeFileSync(
  join(appRoot, "resources/people.ts"),
  `import { sanoma } from "sanoma/resources";\n\n${PEOPLE.map((id, i) => `export const p${i} = sanoma.person({ id: "${id}" });\n`).join("")}`,
);
mkdirSync(join(appRoot, "policies"));
writeFileSync(
  join(appRoot, "policies/hold.cedar"),
  `@hold("marketing-lead")
@title("${HOLD_TITLE}")
forbid (principal == Sanoma::Principal::"held", action == Sanoma::Action::"ghost.post.publish", resource);
`,
);
const featureFile = join(scenariosDir, "announce.feature");
/** A vendor with a workflow operation and no setup, so no fake: its connector page says so. */
const chat = defineConnector("chat", {
  message: { send: { effect: "send", input: z.object({ text: z.string() }), output: z.object({}) } },
});
// Live runs call these fakes; each sandbox run fakes of its own, seeded from the scenarios.
const config = defineConfig({
  workflows: [announce],
  connectors: [...vendors.connectors, ...company.connectors, chat],
  collections: [outbound],
  ledger: memoryLedger(),
  databaseUrl: testDatabaseUrl("app"),
  root: appRoot,
});

let worker: Worker;
let app: App;
/** The app's context, as the server functions get it. */
let ctx: AppContext;
/** The run the server function tests start, which the page tests then look for. */
let runId: string;
/** The sandbox run the scenario tests start, which the page tests then render. */
let sandboxId: string;
const SCENARIO = "Launch on time";

/** The clients `contextOf` connects, closed after the file's tests. */
const clients: SanomaClient[] = [];

/**
 * The context startApp builds for a config and hands every request, on a client of its own: the
 * server functions call the server core with it.
 */
async function contextOf(cfg: SanomaConfig, login = loopbackLogin()): Promise<AppContext> {
  const client = await SanomaClient.connect(cfg);
  clients.push(client);
  const resolved = resolveConfig(cfg);
  return {
    resolved,
    description: describeConfig(cfg),
    client,
    place: placeOf(resolved.databaseUrl),
    login: admitting(login, () => ({ people: [], problems: [] })),
  };
}

beforeAll(async () => {
  npm.listen({ onUnhandledFrame: "bypass" });
  ensureBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
  worker = await startWorker(config);
  app = await startApp(config, { port: 0, ingress: [machineRoute, machinesRoute] });
  ctx = await contextOf(config);
});

afterEach(() => npm.resetHandlers());

afterAll(async () => {
  npm.close();
  await app?.close();
  await Promise.all(clients.map((client) => client.close()));
  await worker?.stop();
  rmSync(appRoot, { recursive: true, force: true });
});

/** A machine route, as the wakeup's `/wake` is: it answers 204 with the query it was given. */
const machineRoute: IngressRoute = {
  method: "GET",
  path: "/machine",
  handle: async (request) =>
    new Response(null, {
      status: 204,
      headers: { "x-query": new URL(request.url).search },
    }),
};

/** A prefix route, as the wakeup service's `/wakeup`: it answers 200 with the path it was given. */
const machinesRoute: IngressRoute = {
  path: "/machines",
  prefix: true,
  handle: async (request) => new Response(new URL(request.url).pathname, { status: 200 }),
};

/** Starts the app with `machineRoute` at each of `paths`. */
const ingressAt = (...paths: string[]) =>
  startApp(config, { ingress: paths.map((path) => ({ ...machineRoute, path })) });

/** Who is asking: the `x-sanoma-actor` header the page sends, or other headers, to an app's context. */
interface As {
  actor?: string;
  headers?: Record<string, string>;
  /** The file's own by default. */
  app?: AppContext;
}

/** What start.ts's `actor` middleware gives a server function for a request with these headers. */
function asking({ actor, headers, app: context = ctx }: As = {}): ActorContext {
  const all = actor === undefined ? { ...headers } : { ...headers, [ACTOR_HEADER]: actor };
  return { app: context, actor: actorOf(context, new Request("http://127.0.0.1/", { headers: all })) };
}

/**
 * A server function's answer as the page receives it: its result, or, with `status`, the
 * ApiError it fails with (`serverFnFailure`, which start.ts's `apiErrors` middleware throws). The
 * router's not-found, a read's answer for nothing found, is thrown.
 */
async function answer<T>(
  method: "GET" | "POST",
  work: () => Promise<T>,
): Promise<{ status?: number; body: T & Partial<ErrorResponse> }> {
  try {
    return { body: (await work()) as T & Partial<ErrorResponse> };
  } catch (err) {
    const failure = serverFnFailure(err, method);
    if (!(failure instanceof ApiError)) throw failure;
    return { status: failure.status, body: failure.body as T & Partial<ErrorResponse> };
  }
}

/**
 * A change as its server function makes it (see functions.ts): `withPrincipal`'s `requireActor`,
 * then the function's validator, then its handler's server core call.
 */
const change =
  <I, D, T>(read: (data: I) => D, call: (app: AppContext, actor: Principal, data: D) => Promise<T>) =>
  (data: unknown, as: As = {}) =>
    answer("POST", async () => {
      const request = asking(as);
      const actor = await requireActor(request);
      return call(request.app, actor, read(data as I));
    });

/** `startRunFn`: a workflow and its input, or a scenario. */
const startAs = change(readStartRun, startRun);
/** `decideFn`: `{ runId, approvalId, decision, note? }`. */
const decideAs = change(validate(DecideCall), decide);
/** `setCredentialFn` and `clearCredentialFn`. */
const setAs = change(validate(SetCredentialRequest), setCredential);
const clearAs = change(validate(ClearCredentialRequest), clearCredential);

/** `getRuns`: the latest runs, by the query. */
const runsOf = (query: Record<string, unknown> = {}) =>
  answer("GET", async () => listRuns(ctx, validate(RunsQuery)(query as RunsQuery)));

/** `getRun`: one run, its ledger, its approvals and a sandbox run's checks. */
const detail = (id: string, context = ctx) => runDetail(context, id);

/** `startRunFn` with this argument, as tester. */
const postRun = (data: unknown) => startAs(data, { actor: "tester" });

/**
 * A laptop's window, for Chrome: the bar, the chat column and the page side by side, the page's
 * card too narrow for a floating card beside its list until the column folds.
 */
const LAPTOP = { width: 1280, height: 800 };

/** A page as the server renders it, and its text without the comments React puts between text parts. */
async function page(path: string, base = app.url, init?: RequestInit) {
  const res = await fetch(new URL(path, base), init);
  const html = await res.text();
  return { status: res.status, html, text: html.replaceAll("<!-- -->", "") };
}

/** The bar's Chat button: whether the chat column is open (`aria-expanded`), the column it controls then. */
function chatOpen(html: string) {
  const button = html.match(/<button [^>]*>(?:(?!<\/button>)[\s\S])*Chat<\/button>/)?.[0] ?? "";
  const open = button.includes('aria-expanded="true"');
  expect(button.includes('aria-controls="chat"')).toBe(open);
  return open;
}

/**
 * A page's tabs (`LinkTabs`), in order: each one's label, link, count (when it shows one) and
 * whether it is the view showing.
 */
const tabs = (html: string) =>
  [
    ...html.replaceAll("<!-- -->", "").matchAll(/<a ([^>]*role="tab"[^>]*)>([^<]+)(?:<span[^>]*>(\d+)<\/span>)?<\/a>/g),
  ].map(([, tag, label, count]) => ({
    label,
    href: tag!.match(/href="([^"]*)"/)?.[1]?.replaceAll("&amp;", "&"),
    count: count === undefined ? undefined : Number(count),
    selected: tag!.includes('aria-selected="true"'),
  }));

/** The tab labelled `label`. */
const tabNamed = (html: string, label: string) => tabs(html).find((t) => t.label === label);

/** The floating cards over a page's card (`FloatingCard`, a shadowed card), each by its label. */
const floats = (html: string) =>
  [...html.matchAll(/<div data-slot="card"(?=[^>]*class="[^"]*\bshadow-lg\b)[^>]*aria-label="([^"]+)"/g)].map(
    ([, label]) => label,
  );

/** The rows of a workflow's Runs tab: each run id its row opens (`?run=`), in order. */
const runRows = (html: string) =>
  [...html.matchAll(/<a [^>]*href="\/workflows\/announce\?([^"]*)"[^>]*>Run [0-9a-f]{8}<\/a>/g)].map(([, search]) =>
    new URLSearchParams(search!.replaceAll("&amp;", "&")).get("run"),
  );

/** The opening tag of the link whose text, after any icon, is `label`, or an Item's title. */
function linkTag(html: string, label: string) {
  const at = html.search(new RegExp(`>${label}(?:</(?:div|span)>)*</a>`));
  if (at < 0) return undefined;
  const start = html.lastIndexOf("<a ", at);
  return html.slice(start, html.indexOf(">", start) + 1);
}

/** The Inbox's rows, in order, each its link's search: `approval`, and `show` when it keeps one. */
const inboxRows = (html: string) =>
  [...html.matchAll(/<a [^>]*href="\/inbox\?([^"]*approval=[^"]*)"[^>]*>/g)].map(([tag, search]) => {
    const params = new URLSearchParams(search!.replaceAll("&amp;", "&"));
    return { approval: params.get("approval"), show: params.get("show"), current: tag.includes('aria-current="page"') };
  });

/** The approval open beside the Inbox's list: the row marked current. */
const currentRow = (html: string) => inboxRows(html).find((row) => row.current)?.approval;

/** The open approval's title: the floating card's name. */
const openTitle = (html: string) => floats(html)[0];

/** A request's status, sent as written: no normalising of the path, and any Host header. */
function rawStatus(base: string, path: string, headers?: Record<string, string>) {
  const { hostname, port } = new URL(base);
  return new Promise<number>((done, fail) => {
    httpRequest({ host: hostname, port, path, headers }, (r) => {
      r.resume();
      done(r.statusCode ?? 0);
    })
      .on("error", fail)
      .end();
  });
}
const input = (title: string) => ({
  title,
  body: "<p>Hello</p>",
  launchAt: new Date(Date.now() - 60_000).toISOString(),
});

describe("the server functions", () => {
  it("lists the connector packages on npm, from each one's latest version, Sanoma's first", async () => {
    const { connectors, error } = await availableConnectors();
    expect(error).toBeUndefined();
    expect(connectors).toEqual([
      {
        package: "@sanoma-ai/connector-acme",
        title: "Acme",
        description: "Acme's orders",
        version: "1.2.0",
        // Read from jsDelivr, as data: URLs, as installed vendors' are.
        logo: {
          src: svgDataUrl(NPM_LOGOS["@sanoma-ai/connector-acme@1.2.0/logo.svg"]!),
          dark: svgDataUrl(NPM_LOGOS["@sanoma-ai/connector-acme@1.2.0/logo-dark.svg"]!),
        },
        homepage: "https://acme.example/code",
      },
      // Installed too: the page leaves it out, against the config it shows.
      { package: "@sanoma-ai/connector-ghost", title: "Ghost", version: "9.9.9" },
      // A logo that is no <svg> element, and a homepage that is not https, are left out; a
      // package whose logo is outside it, as one with no `sanoma` field, is not listed.
      { package: "sanoma-connector-widgets", title: "Widgets", version: "0.1.0" },
    ]);
  });

  it("says why when npm cannot be searched, and lists nothing", async () => {
    npmSearchFails(() => new HttpResponse(null, { status: 503 }));
    expect(await availableConnectors()).toEqual({
      connectors: [],
      error: "Could not search npm: registry.npmjs.org answered 503 to /-/v1/search",
    });
  });

  it("says when each workflow on a schedule fires next, in its time zone, and nothing for one started by hand", () => {
    const workflows = [
      { name: "nightly", trigger: { schedule: "0 9 * * *", timezone: "Europe/Amsterdam" } },
      { name: "hourly", trigger: { schedule: "0 * * * *" } },
      { name: "by-hand", trigger: "manual" },
    ];
    expect(nextFires({ description: { workflows } as never }, new Date("2026-10-25T10:30:00Z"))).toEqual({
      nightly: "2026-10-26T08:00:00.000Z",
      hourly: "2026-10-25T11:00:00.000Z",
    });
  });

  it("describe the config: workflows, ops, built-ins, the policy and the version, without the workflows' sources, and where the instance is", async () => {
    const body = appConfig(ctx);
    // The test database is on this machine; of its URL, only the host is sent.
    expect(body.place).toBe("this-computer");
    expect(body.databaseHost).toBe(databaseHost(ctx.resolved.databaseUrl));
    expect(JSON.stringify(body)).not.toContain(ctx.resolved.databaseUrl);
    expect(body.appName).toBe("sanoma");
    expect(body.version).toMatch(/^sanoma@/);
    expect(body.policy).toEqual({ defined: true, version: expect.stringMatching(/^[0-9a-f]{12}$/) });
    const wf = body.workflows.find((w) => w.name === "announce");
    expect(wf?.ops).toHaveLength(5);
    expect(wf?.ops).toEqual(expect.arrayContaining(["ghost.post.publish", "resend.broadcast.send"]));
    expect(wf?.builtins).toEqual(["approval", "sleep"]);
    // Each workflow's outline, read from its file when the app started; the file itself is not sent.
    expect(wf?.outline).toEqual(outlineWorkflow(announce));
    expect(wf?.outline).toMatchObject({ file: expect.stringMatching(/announce\.ts$/) });
    expect(body.workflows.every((w) => !("source" in w))).toBe(true);
    // Nor is its code anywhere else in the description, or in the page that carries it.
    const line = "ctx.ghost.post.create({ title, html: body";
    expect(readFileSync(announce.file!, "utf8")).toContain(line);
    expect(JSON.stringify(body)).not.toContain(line);
    expect((await page("/workflows")).html).not.toContain(line);
    expect(body.ops.find((o) => o.id === "resend.broadcast.send")?.effect).toBe("send");
    // Whether each vendor's connector attaches a fake: Ghost's and GitHub's do, chat's does not.
    expect(body.vendors).toMatchObject({ ghost: { fake: true }, github: { fake: true }, chat: { fake: false } });
    expect(body.vendors.resend).toMatchObject({ title: "Resend", logo: { src: expect.stringMatching(/^data:/) } });
    // The data files under the config's root, without problems, passed through as they are: the people too.
    expect(body.resources.map((r) => r.id)).toEqual([
      ...company.declared.map((r) => r.id),
      ...PEOPLE.map((_, i) => `resources/people.ts#p${i}`),
    ]);
    expect(body.problems).toEqual([]);
    // Its collections, with where resources/data.ts declares each.
    expect(body.collections.map((c) => [c.name, c.declared?.id])).toEqual([["outbound", "resources/data.ts#outbound"]]);
    // And the built-in drift workflow, since the connectors declare resource types.
    expect(body.workflows.find((w) => w.name === "drift")).toMatchObject({ builtin: true });
  });

  it("refuse a run without an actor, for an unknown workflow, or with input the schema refuses", async () => {
    const anonymous = await startAs({ workflow: "announce", input: input("x") });
    expect(anonymous.status).toBe(400);
    expect(anonymous.body).toMatchObject({ code: "invalid_input", error: expect.stringMatching(/x-sanoma-actor/) });

    const unknown = await startAs({ workflow: "nope", input: {} }, { actor: "alice" });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({
      code: "invalid_input",
      issues: [expect.objectContaining({ path: ["workflow"] })],
    });

    const { title: _, ...untitled } = input("x");
    const invalid = await startAs({ workflow: "announce", input: untitled }, { actor: "alice" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("invalid_input");
    expect(invalid.body.issues).toEqual([expect.objectContaining({ path: ["title"], message: expect.any(String) })]);

    expect((await runsOf({ limit: 0 })).status).toBe(400);
    const badStatus = await runsOf({ status: "asleep" });
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.issues).toEqual([expect.objectContaining({ path: ["status"] })]);
  });

  it("start a run as the actor, hold it for the approver, refuse anyone else, then finish", async () => {
    const started = await startAs(
      { workflow: "announce", input: input("From the app") },
      { actor: encodeURIComponent("Ålice") },
    );
    expect(started).toEqual({ body: { runId: expect.any(String), workflow: "announce" } });
    runId = started.body.runId;

    const runs = await runsOf({ limit: 50 });
    expect(runs.body.find((r) => r.runId === runId)).toMatchObject({
      workflow: "announce",
      startedBy: { id: "Ålice" },
    });

    const held = await waitFor(
      () => detail(runId),
      (d) => d.approvals.some((a) => a.status === "pending"),
    );
    const approval = held.approvals[0]!;
    expect(approval).toMatchObject({ id: "approval-1", approver: "marketing-lead", status: "pending" });
    expect(held.run.status).toBe("waiting");
    const waiting = await runsOf({ status: "waiting" });
    expect(waiting.body.map((r) => r.runId)).toContain(runId);
    expect(waiting.body.every((r) => r.status === "waiting")).toBe(true);
    const call = { runId, approvalId: approval.id };

    const anonymous = await decideAs({ ...call, decision: "approve" });
    expect(anonymous.status).toBe(400);
    expect(anonymous.body.code).toBe("invalid_input");
    const wrong = await decideAs({ ...call, decision: "approve" }, { actor: "someone-else" });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toMatchObject({ code: "not_approver", approver: "marketing-lead" });
    expect((await detail(runId)).approvals[0]?.status).toBe("pending");

    const right = await decideAs({ ...call, decision: "approve", note: "ship it" }, { actor: "marketing-lead" });
    expect(right.body).toMatchObject({ id: "approval-1", status: "approved", decidedBy: "marketing-lead" });

    const again = await decideAs({ ...call, decision: "reject" }, { actor: "marketing-lead" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("already_decided");

    const finished = await waitFor(
      () => detail(runId),
      (d) => d.run.status === "finished",
    );
    const stillWaiting = await runsOf({ status: "waiting" });
    expect(stillWaiting.body.map((r) => r.runId)).not.toContain(runId);
    const ledger = finished.ledger;
    expect(ledger.map((r) => r.type)).toEqual([
      "run.started",
      "op.called",
      "op.called",
      "approval.requested",
      "approval.decided",
      "sleep.started",
      "op.called",
      "op.called",
      "op.called",
      "run.finished",
    ]);
    expect(ledger[0]).toMatchObject({ type: "run.started", actor: { id: "Ålice" } });
    expect(ledger[4]).toMatchObject({ decision: "approve", by: "marketing-lead", note: "ship it" });
    const ops = ledger.flatMap((r) => (r.type === "op.called" ? [[r.op, r.decision.kind]] : []));
    expect(ops).toEqual([
      ["ghost.post.create", "allow"],
      ["resend.broadcast.create", "allow"],
      ["ghost.post.publish", "allow"],
      ["resend.broadcast.send", "allow"],
      ["bluesky.post.create", "allow"],
    ]);
  });

  it("answer with the approval still pending when no worker reads the decision", async () => {
    const started = await startAs({ workflow: "announce", input: input("Nobody home") }, { actor: "alice" });
    const id = started.body.runId;
    await waitFor(
      () => detail(id),
      (d) => d.approvals.some((a) => a.status === "pending"),
    );
    await worker.stop();
    try {
      const sent = await decideAs(
        { runId: id, approvalId: "approval-1", decision: "approve" },
        { actor: "marketing-lead" },
      );
      expect(sent.status).toBeUndefined();
      expect(sent.body).toMatchObject({ id: "approval-1", status: "pending" });
    } finally {
      worker = await startWorker(config);
    }
  });

  it("say when a run or an approval does not exist, by code, and answer a read of one with the router's not-found", async () => {
    await expect(detail("does-not-exist")).rejects.toMatchObject({
      status: 404,
      body: { code: "run_not_found", error: expect.stringMatching(/does-not-exist/) },
    });
    // getRun, a read, finds nothing: the page shows its not-found view.
    await expect(answer("GET", () => detail("does-not-exist"))).rejects.toSatisfy(isNotFound);
    const approval = await decideAs(
      { runId: "does-not-exist", approvalId: "approval-1", decision: "approve" },
      { actor: "marketing-lead" },
    );
    expect(approval.status).toBe(404);
    expect(approval.body.code).toBe("run_not_found");
  });
});

describe("scenarios and sandbox runs", () => {
  it("lists the scenarios in the config's feature files, with their steps", async () => {
    const body = await scenarios(ctx);
    expect(body.errors).toEqual([]);
    expect(body.scenarios.map((s) => s.name)).toEqual([SCENARIO, "Publish retried", "Copy rejected"]);
    const launch = body.scenarios[0]!;
    expect(launch).toMatchObject({
      workflow: "announce",
      file: "announce.feature",
      text: expect.stringMatching(/^Scenario: Launch on time\n/),
    });
    expect(launch.steps).toContainEqual({
      text: 'a post titled "Old news" exists',
      kind: "given",
      op: "ghost.post.create",
    });
    expect(launch.steps).toContainEqual({ text: "the run succeeds", kind: "then" });
    // Its own lines of the feature file: not the feature's, nor the next scenario's.
    expect(launch.text).not.toContain("Feature:");
    expect(launch.text).not.toContain("Publish retried");
    // What the page lists, not how the worker seeds and checks it.
    expect(launch).not.toHaveProperty("expect");
  });

  it("refuses a request that names both a workflow and a scenario, or neither, at its own field", async () => {
    const both = await postRun({ workflow: "announce", input: {}, scenario: SCENARIO });
    expect(both.status).toBe(400);
    expect(both.body).toMatchObject({ code: "invalid_input", issues: [{ path: [] }] });
    expect(both.body.error).toContain("Send a workflow or a scenario, not both");

    const neither = await postRun({});
    expect(neither.status).toBe(400);
    expect(neither.body.issues).toContainEqual(expect.objectContaining({ path: ["workflow"] }));

    const noWorkflow = await postRun({ workflow: "" });
    expect(noWorkflow.body.issues).toContainEqual(
      expect.objectContaining({ path: ["workflow"], message: "Name a workflow" }),
    );

    const noScenario = await postRun({ scenario: "" });
    expect(noScenario.status).toBe(400);
    expect(noScenario.body.issues).toEqual([
      expect.objectContaining({ path: ["scenario"], message: "Name a scenario" }),
    ]);
  });

  it("refuses a scenario the config does not have, naming those it has", async () => {
    const { status, body } = await postRun({ scenario: "nope" });
    expect(status).toBe(404);
    expect(body).toMatchObject({ code: "invalid_input", issues: [expect.objectContaining({ path: ["scenario"] })] });
    expect(body.error).toBe(
      'No scenario named "nope"; the scenarios are "Launch on time", "Publish retried", "Copy rejected"',
    );
  });

  it("starts a sandbox run whose approval waits for a person, then checks it against the scenario", async () => {
    const started = await postRun({ scenario: SCENARIO });
    // The scenario's workflow, which the request did not name: the run's page is under it.
    expect(started.body.workflow).toBe("announce");
    sandboxId = started.body.runId;

    // The app decides nothing: the run waits on its approval as a live run does.
    const held = await waitFor(
      () => detail(sandboxId),
      (d) => d.approvals.some((a) => a.status === "pending"),
    );
    expect(held.run).toMatchObject({ status: "waiting", sandbox: SCENARIO, startedBy: { id: "tester" } });
    expect(held.ledger.find((r) => r.type === "scenario.seeded")).toMatchObject({
      scenario: SCENARIO,
      seeds: [
        expect.objectContaining({ op: "ghost.post.create", input: expect.objectContaining({ title: "Old news" }) }),
      ],
    });
    // A call it expects has been made, so that check is settled; the outcome is not yet.
    expect(held.checks).toContainEqual({ step: 'a post titled "Acme Pro" is created', ok: true, settled: true });
    expect(held.checks).toContainEqual({
      step: "the run succeeds",
      ok: false,
      detail: "run not ended",
      settled: false,
    });

    const decided = await decideAs(
      { runId: sandboxId, approvalId: held.approvals[0]!.id, decision: "approve" },
      { actor: "marketing-lead" },
    );
    expect(decided.body.status).toBe("approved");
    const done = await waitFor(
      () => detail(sandboxId),
      (d) => d.run.status === "finished",
    );
    expect(done.checks).toHaveLength(5);
    expect(done.checks?.filter((c) => !c.ok)).toEqual([]);
  });

  it("settles a check once its answer cannot change, and fails those not met when the run ends", async () => {
    const started = await postRun({ scenario: "Copy rejected" });
    const id = started.body.runId;
    const held = await waitFor(
      () => detail(id),
      (d) => d.approvals.some((a) => a.status === "pending"),
    );
    // A call not made so far may still be made: not settled, though met.
    expect(held.checks).toEqual([
      { step: "ghost.post.publish was not called", ok: true, settled: false },
      expect.objectContaining({ step: "resend.broadcast.send was called", ok: false, settled: false }),
      { step: 'the run fails with "approval_rejected"', ok: false, detail: "run not ended", settled: false },
    ]);
    expect((await page(`/workflows/announce/runs/${id}`)).text).toMatch(/>not yet</);

    const decided = await decideAs(
      { runId: id, approvalId: held.approvals[0]!.id, decision: "reject" },
      { actor: "marketing-lead" },
    );
    expect(decided.body.status).toBe("rejected");
    const failed = await waitFor(
      () => detail(id),
      (d) => d.run.status === "failed",
    );
    expect(failed.checks).toEqual([
      { step: "ghost.post.publish was not called", ok: true, settled: true },
      expect.objectContaining({ step: "resend.broadcast.send was called", ok: false, settled: true }),
      { step: 'the run fails with "approval_rejected"', ok: true, settled: true },
    ]);
  });
});

describe("scenarios that no longer load", () => {
  it("says why a seeded run has no checks, and why a scenario cannot start, when its file breaks", async () => {
    const before = await detail(sandboxId);
    expect(before.checks).toBeDefined();
    const text = readFileSync(featureFile, "utf8");
    try {
      writeFileSync(featureFile, "Feature: Broken\n  Scenario: Broken\n    Then nothing\n");
      const broken = await detail(sandboxId);
      expect(broken.checks).toBeUndefined();
      expect(broken.checksError).toMatch(
        /^The feature files no longer have scenario "Launch on time"; these files did not load: announce\.feature:3: no step matches "nothing"\nKnown steps:/,
      );
      const run = await page(`/workflows/announce/runs/${sandboxId}`);
      expect(run.html).toMatch(/<h2[^>]*>Checks<\/h2>/);
      expect(run.text).toContain("Could not check the run against its scenario: The feature files no longer have");
      // A workflow with no scenarios has its New run form's Sandbox disabled, and says why.
      const pane = await page("/workflows/announce?new");
      expect(pane.text).toContain("Could not read a scenario: announce.feature:3");
      const sandboxLink = linkTag(pane.html, "Sandbox");
      expect(sandboxLink).toContain('aria-disabled="true"');
      expect(sandboxLink).not.toContain("href=");
      expect(pane.text).toContain("No scenarios for this workflow yet");
      // A connector's page says why too, above its operations.
      const connector = await page("/connectors/ghost");
      expect(connector.text).toMatch(
        /Could not read a scenario: announce\.feature:3: no step matches &quot;nothing&quot;[\s\S]*<h2[^>]*>Operations<\/h2>/,
      );

      const start = await postRun({ scenario: SCENARIO });
      expect(start.status).toBe(404);
      expect(start.body.error).toMatch(/; these files did not load: announce\.feature:3: no step matches "nothing"/);
    } finally {
      writeFileSync(featureFile, text);
    }
    expect((await detail(sandboxId)).checks).toEqual(before.checks);
  });

  it("lists no scenarios, with why, when they cannot be read at all", async () => {
    const resolved = {
      scenarios: pathToFileURL(`${scenariosDir}/`),
      get ops(): never {
        throw new Error("the ops are gone");
      },
    };
    expect(await scenarios({ resolved } as never)).toEqual({
      scenarios: [],
      errors: [{ file: "", message: "the ops are gone" }],
    });
  });
});

describe("errors the app answers with", () => {
  it("answers anything unexpected with a 500 that names no detail", () => {
    const api = asApiError(new Error("connect ECONNREFUSED db.internal:5432"));
    expect(api.status).toBe(500);
    expect(api.body).toEqual({ error: "Something went wrong" });
  });

  it("answers an argument a schema refuses, a server function's included, with 400 and the issues", () => {
    let api: unknown;
    try {
      parse(z.object({ runId: z.string().min(1) }), { runId: "" }, "The request");
    } catch (err) {
      api = err;
    }
    if (!(api instanceof ApiError)) throw new Error("expected an ApiError");
    expect(api.status).toBe(400);
    expect(api.body).toMatchObject({
      code: "invalid_input",
      error: expect.stringMatching(/^The request: runId: /),
      issues: [expect.objectContaining({ path: ["runId"] })],
    });
  });
});

describe("a file's source", () => {
  it("is served for a file the description names, a workflow's or a data file, a collection's too, apart from the config", async () => {
    const description = describeConfig(config);
    const context = { resolved: { root: companyDir } as never, description };
    expect(await fileSource(context, announce.file!)).toEqual({
      source: readFileSync(announce.file!, "utf8").replaceAll("\r\n", "\n"),
    });
    expect(await fileSource(context, "resources/identity/rules.ts")).toEqual({
      source: readFileSync(join(companyDir, "resources/identity/rules.ts"), "utf8"),
    });
    // A collection's, resources/data.ts, which declares no resource.
    expect(await fileSource({ ...context, resolved: { root: appRoot } as never }, "resources/data.ts")).toEqual({
      source: readFileSync(join(appRoot, "resources/data.ts"), "utf8"),
    });
    expect(withoutSources(description).workflows.find((wf) => wf.name === "announce")).not.toHaveProperty("source");
    // Nothing else, and not a 404: the page asking would take it for its own not-found.
    for (const file of ["sanoma.config.ts", "resources/../sanoma.config.ts", join(companyDir, "sanoma.config.ts")]) {
      expect(await fileSource(context, file)).toEqual({ source: null });
    }
  });
});

describe("the page", () => {
  it("renders the workflows on the server, in the shell: the bar's sections, the chat column open, and no runs or Start page, and the theme left to the browser", async () => {
    const res = await fetch(new URL("/workflows", app.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('<div id="app">');
    expect(html).toMatch(/<h1[^>]*>Workflows<span[^>]*>4<\/span><\/h1>/);
    // The bar: Chat, then Inbox and Workflows, no site tiles (the package's own build has no
    // sites), then Setup (with Data and Permissions, as the config has collections and a policy),
    // the current lit.
    expect(barLabels(html)).toEqual([
      ["Inbox", "Workflows"],
      ["Data", "Resources", "Connectors", "Apps", "Permissions", "Go live"],
    ]);
    expect(barLink(html, "/apps")).toBeDefined();
    expect(barLink(html, "/workflows")).toMatch(/data-active="true"[^>]*aria-current="page"/);
    expect(barLink(html, "/inbox")).not.toMatch(/data-active="true"|aria-current/);
    // At its foot, what the window is, the test database being on this machine, its tip the host.
    expect(html).toMatch(/>This computer<\/span><span [^>]*hidden="">Database on [^<@]+<\/span>/);
    // The config has a policy: Permissions says what it does, so the overview says nothing of it.
    expect(html).not.toContain("No policy");
    // The chat column, open with no cookie: a new chat's empty state, and the composer carrying the
    // page as a chip, with Send waiting for a message (chat.test.ts drives the agent).
    expect(chatOpen(html)).toBe(true);
    const column = html.match(/<aside id="chat" aria-label="Chat"[^>]*>([\s\S]*?)<\/aside>/)?.[1];
    expect(column).toContain(">What should change?<");
    expect(column).toContain("Ask the agent: it drafts the change on a branch of its own");
    expect(column).toContain(">New chat<");
    expect(column).toMatch(
      /<span[^>]*><span[^>]*>Workflows<\/span><\/span><textarea(?![^>]*disabled="")[^>]*aria-label="Message the agent"/,
    );
    expect(column).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Send"/);
    // A new chat's engine, chosen in the composer: our loop first, a person's own agents last.
    const engines = column?.match(/<select[^>]*aria-label="Engine"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? "";
    expect([...engines.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((option) => option[1])).toEqual([
      "Sanoma",
      "Pi",
      "Claude Code",
      "Copilot (your plan)",
      "OpenCode (your plan)",
      "Pi (your plan)",
      "Claude Code (your plan)",
      "Codex (your plan)",
    ]);
    expect(html).toContain('href="/workflows/announce"');
    expect(html).not.toContain('href="/runs"');
    expect(html).not.toContain('href="/start');
    expect(html).toContain("sanoma.theme");
    expect(html.match(/<html[^>]*>/)?.[0]).not.toMatch(/class="[^"]*\bdark\b/);
  });

  it("redirects /, /runs, /start and a run's old URL to their pages under /workflows, and not-found for a run that does not exist", async () => {
    // `/start?workflow=` goes to that workflow's page, which says when it does not exist.
    for (const [path, to] of [
      ["/", /\/workflows$/],
      ["/runs", /\/workflows\?view=runs$/],
      ["/start", /\/workflows$/],
      ["/start?workflow=announce", /\/workflows\/announce\?new=true$/],
      ["/start?workflow=nope", /\/workflows\/nope\?new=true$/],
      // The New run pane's old URL goes to the workflow's New run, keeping its scenario and filter.
      ["/workflows/announce/new?scenario=Launch+on+time", /\/workflows\/announce\?scenario=Launch\+on\+time&new=true$/],
      ["/workflows/announce/new?runs=sandbox", /\/workflows\/announce\?runs=sandbox&new=true$/],
    ] as const) {
      const res = await fetch(new URL(path, app.url), { redirect: "manual" });
      expect(res.status, path).toBe(307);
      expect(res.headers.get("location"), path).toMatch(to);
    }
    expect((await page("/workflows/nope/new")).status).toBe(404);
    // A search value the router reads as a number names no workflow: the router drops it first.
    const numeric = await fetch(new URL("/start?workflow=123", app.url));
    expect(new URL(numeric.url).pathname).toBe("/workflows");
    const old = await fetch(new URL(`/runs/${runId}`, app.url), { redirect: "manual" });
    expect(old.status).toBe(307);
    expect(old.headers.get("location")?.endsWith(`/workflows/announce/runs/${runId}`)).toBe(true);
    // A run under another workflow's page goes to its own workflow's, under one that does not
    // exist too: the run is read before the page could say there is no such workflow.
    for (const name of ["drift", "typo"]) {
      const elsewhere = await fetch(new URL(`/workflows/${name}/runs/${runId}`, app.url), { redirect: "manual" });
      expect(elsewhere.status, name).toBe(307);
      expect(elsewhere.headers.get("location")?.endsWith(`/workflows/announce/runs/${runId}`), name).toBe(true);
    }
    const missing = await page("/runs/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("No run does-not-exist");
  });

  it("renders a run the policy held: its card in the inbox while held, then the hold, the notes and the records", async () => {
    const started = await startAs({ workflow: "announce", input: input("Held by the policy") }, { actor: "held" });
    const id = started.body.runId;
    const approveAs = (approvalId: string, note: string) =>
      decideAs({ runId: id, approvalId, decision: "approve", note }, { actor: "marketing-lead" });
    await waitFor(
      () => detail(id),
      (d) => d.approvals.some((a) => a.status === "pending"),
    );
    // The note is trimmed, and one with nothing in it is left out.
    expect((await approveAs("approval-1", "  copy is fine  ")).body).toMatchObject({ note: "copy is fine" });

    const held = await waitFor(
      () => detail(id),
      (d) => d.approvals.some((a) => a.requestedBy === "policy"),
    );
    const hold = held.approvals.find((a) => a.requestedBy === "policy")!;
    expect(hold).toMatchObject({ title: HOLD_TITLE, op: "ghost.post.publish", status: "pending" });
    const inbox = await page("/inbox");
    expect(inbox.status).toBe(200);
    expect(inbox.text).toContain(HOLD_TITLE);
    // `?approval=` opens the hold, the sentence above it saying what it lets through.
    const open = await page(`/inbox?approval=${id}/${hold.id}`);
    // It floats over the list's card: a floating card named for it, Approve and Reject at its foot.
    expect(floats(open.html)).toEqual([HOLD_TITLE]);
    const float = open.html.slice(open.html.indexOf(`aria-label="${HOLD_TITLE}"`));
    const footer = float.indexOf('data-slot="card-footer"');
    expect(footer).toBeGreaterThan(0);
    expect(float.indexOf(">Approve</button>")).toBeGreaterThan(footer);
    expect(float.indexOf(">Reject</button>")).toBeGreaterThan(footer);
    expect(open.text).toContain(
      `held&#x27;s run</a> of <a href="/workflows/announce">Announce a launch</a> wants to publish a post in Ghost: “${HOLD_TITLE}”, by <code>policies/hold.cedar#1</code>.`,
    );

    const decided = await approveAs(hold.id, "   ");
    expect(decided.body).toMatchObject({ status: "approved" });
    expect(decided.body.note).toBeUndefined();
    const done = await waitFor(
      () => detail(id),
      (d) => d.run.status === "finished",
    );
    const notes = done.ledger.flatMap((r) => (r.type === "approval.decided" ? [r.note] : []));
    expect(notes).toEqual(["copy is fine", undefined]);

    const run = await page(`/workflows/announce/runs/${id}`);
    expect(run.status).toBe(200);
    expect(run.text).toContain(`“${HOLD_TITLE}” asked of marketing-lead`);
    expect(run.text).toContain(`marketing-lead approved “${HOLD_TITLE}”`);
    expect(run.text).toContain("copy is fine");
    expect(run.text).toMatch(/approved by marketing-lead/);
    expect(run.text).toContain("<code>ghost.post.publish</code>");
    // Each call after its vendor's logo, the dark theme's variant hidden until it applies.
    expect(run.html).toMatch(/<img src="data:image\/svg\+xml,[^"]+" alt="Ghost" class="[^"]*dark:hidden[^"]*"\/>/);
    expect(run.html).toMatch(
      /<img src="data:image\/svg\+xml,[^"]+" alt="Ghost" class="hidden [^"]*dark:block[^"]*"\/>/,
    );
    expect(run.text).toContain("Started by held");
    expect(run.text).toMatch(/>finished<\/span>/);

    // Decided lists it from the latest runs, and opens it with no controls.
    const decidedPage = await page(`/inbox?show=decided&approval=${id}/${hold.id}`);
    // The Decided tab is the one showing.
    expect(tabNamed(decidedPage.html, "Decided")).toMatchObject({ href: "/inbox?show=decided", selected: true });
    expect(openTitle(decidedPage.html)).toBe(HOLD_TITLE);
    expect(decidedPage.text).toContain("wanted to publish a post in Ghost");
    expect(decidedPage.text).toContain("approved by marketing-lead");
    // Its row says how it was decided, not only by colour.
    expect(decidedPage.text).toContain("approved · Announce a launch · from held");
    expect(decidedPage.text).not.toContain(">Approve<");
  });

  it("lists the pending approvals beside the one open, newest first, each row opening its own", async () => {
    const ids: string[] = [];
    for (const title of ["Inbox first", "Inbox second"]) {
      const started = await postRun({ workflow: "announce", input: input(title) });
      await waitFor(
        () => detail(started.body.runId),
        (d) => d.run.status === "waiting",
      );
      ids.push(started.body.runId);
    }
    const [first, second] = ids.map((id) => `${id}/approval-1`);

    // The server knows no name: every pending approval, the newest open and marked in the list.
    const inbox = await page("/inbox");
    expect(inbox.status).toBe(200);
    const rows = inboxRows(inbox.html).map((row) => row.approval);
    expect(rows.indexOf(second!)).toBeGreaterThanOrEqual(0);
    expect(rows.indexOf(second!)).toBeLessThan(rows.indexOf(first!));
    expect(currentRow(inbox.html)).toBe(rows[0]);
    expect(inbox.text).toContain("tester&#x27;s run</a> of");
    expect(inbox.text).toContain("is waiting on this decision: “");
    expect(inbox.text).toMatch(/Announce a launch · from tester/);
    expect(inbox.html).toContain(">Approve<");

    // `?approval=` opens that one; each row keeps the filter.
    const opened = await page(`/inbox?show=waiting&approval=${first}`);
    expect(currentRow(opened.html)).toBe(first);
    expect(opened.html).toContain(`href="/workflows/announce/runs/${ids[0]}"`);
    expect(inboxRows(opened.html)).toEqual(
      rows.map((approval) => ({ approval, show: "waiting", current: approval === first })),
    );

    // One no longer pending, or never, opens the first instead.
    expect(currentRow((await page("/inbox?approval=nothing/approval-1")).html)).toBe(rows[0]);
  });

  it("tabs the Inbox For you, Everyone and Decided, each its own URL, counts what waits in its title, and says when nothing waits for you", async () => {
    const inbox = await page("/inbox?approval=x");
    // Without a name, Everyone is what shows, and it says how many; For you has no count until
    // the browser knows who you are.
    const pending = tabNamed(inbox.html, "Everyone")?.count;
    expect(pending).toBeGreaterThan(0);
    expect(tabs(inbox.html)).toEqual([
      { label: "For you", href: "/inbox?show=mine", count: undefined, selected: false },
      { label: "Everyone", href: "/inbox?show=waiting", count: pending, selected: true },
      { label: "Decided", href: "/inbox?show=decided", count: undefined, selected: false },
    ]);
    expect(inbox.text).toMatch(new RegExp(`<h1[^>]*>Inbox<span[^>]*>${pending}</span></h1>`));
    const mine = await page("/inbox?show=mine");
    expect(tabNamed(mine.html, "For you")?.selected).toBe(true);
    expect(mine.text).toContain("Nothing is waiting for you");
    expect(floats(mine.html)).toEqual([]);
    // A link to them.
    expect(mine.text).toMatch(
      /<a[^>]*href="\/inbox\?show=waiting"[^>]*>Show the \d+ approvals? waiting on others<\/a>/,
    );
  });

  it("says a failed call that is not safe to repeat was not retried, and where to look", async () => {
    blog.failNext("ghost.post.create", new DriverError("ghost: the site is down", { retryable: false, status: 503 }));
    const started = await startAs({ workflow: "announce", input: input("Fails at once") }, { actor: "alice" });
    await waitFor(
      () => detail(started.body.runId),
      (d) => d.run.status === "failed",
    );
    const run = await page(`/workflows/announce/runs/${started.body.runId}`);
    expect(run.text).toContain("ghost: the site is down");
    expect(run.text).toContain("Not retried: this operation is not safe to repeat. Check Ghost before starting again.");
    // The run's error is a notice above the graph, and not a fact again below it.
    const notice = run.html.search(/data-slot="alert-description"[^>]*>[^<]*ghost: the site is down/);
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(run.html.search(/role="region" aria-label="Graph"/));
    expect(run.html).not.toMatch(/<dt[^>]*>Error<\/dt>/);
  });

  it("renders the workflows on the server: a row for each linking to its page, whose About has its operations and input", async () => {
    const { version } = ctx.description;
    const workflows = await page("/workflows");
    expect(workflows.status).toBe(200);
    expect(workflows.text).toContain(`>${version}</code>`);
    // What it may call and its input are About's, not the overview's.
    expect(workflows.text).not.toMatch(/>safe to retry<\/span>/);
    const about = await page("/workflows/announce");
    expect(about.text).toMatch(/>safe to retry<\/span>/);
    for (const title of ["Ghost", "Resend", "Bluesky"]) {
      expect(about.html).toMatch(new RegExp(`<img src="data:image/svg\\+xml,[^"]+" alt="${title}"`));
    }
    expect(about.text).toMatch(/default (&quot;|")newsletter(&quot;|")/);
    // Each workflow's row links to its page; its outline is on that page.
    expect(workflows.html).toMatch(
      /<tr[^>]*><td[^>]*><div[^>]*><a[^>]*href="\/workflows\/announce"[^>]*>Announce a launch<\/a>/,
    );
    expect(workflows.html).not.toContain('aria-label="Loading the graph"');
  });

  it("lists the connectors, each linking to its page, without their operations", async () => {
    const connectors = await page("/connectors");
    expect(connectors.status).toBe(200);
    expect(connectors.html).toMatch(/<h1[^>]*>Connectors<\/h1>/);
    expect(connectors.text).toContain("<title>Connectors · Sanoma</title>");
    for (const title of ["Ghost", "Resend", "Bluesky", "GitHub"]) expect(connectors.text).toContain(`>${title}<`);
    expect(connectors.html).toContain('href="/connectors/ghost"');
    expect(connectors.text).toContain("2 operations · used by 1 workflow");
    // Only the hydration data, which carries the whole config, names an operation.
    expect(connectors.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")).not.toMatch(/ghost\.post\.create/);
    // The bar, on every page, links to it.
    expect(connectors.html).toContain('href="/connectors"');
  });

  it("lists the connectors on npm not installed, each with how to add it", async () => {
    const { html, text } = await page("/connectors");
    const shown = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
    expect(shown).toMatch(/<h2[^>]*>Installed<\/h2>[\s\S]*<h2[^>]*>Available<\/h2>/);
    // The installed one is left out.
    expect(shown).toContain(">@sanoma-ai/connector-acme<");
    expect(shown).not.toContain(">@sanoma-ai/connector-ghost<");
    expect(text).toContain("Acme&#x27;s orders · v1.2.0");
    expect(shown).toMatch(
      /<img src="data:image\/svg\+xml,[^"]+" alt=""[^>]*><img src="data:image\/svg\+xml,[^"]+"[^>]*>[\s\S]*Acme</,
    );
    expect(shown).toMatch(/>Official<[\s\S]*>Community</);
    expect(shown).toContain('href="/connectors?add=%40sanoma-ai%2Fconnector-acme"');
  });

  it("opens an available connector's steps to add it in a sheet, at its own URL, in Chrome", async (test) => {
    const chrome = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
    if (!existsSync(chrome)) test.skip("no Chrome: install Google Chrome or set CHROME_PATH");
    // A laptop's width: narrower, the chat column lies over the page.
    const browser = await launchChrome({ executablePath: chrome, headless: true, defaultViewport: LAPTOP });
    try {
      const tab = await browser.newPage();
      await tab.goto(new URL("/connectors", app.url).href);
      await tab.evaluate((key) => localStorage.setItem(key, "tester"), ACTOR_KEY);
      await tab.goto(new URL("/connectors", app.url).href, { waitUntil: "networkidle0" });
      await tab.click('a[href="/connectors?add=%40sanoma-ai%2Fconnector-acme"]');
      await tab.waitForSelector('[data-slot="sheet-content"] ::-p-text(pnpm add @sanoma-ai/connector-acme)');
      const readme = await tab.$eval('[data-slot="sheet-content"] a[href^="https://www.npmjs.com/"]', (a) => a.href);
      expect(readme).toBe("https://www.npmjs.com/package/@sanoma-ai/connector-acme");
      expect(new URL(tab.url()).searchParams.get("add")).toBe("@sanoma-ai/connector-acme");
      await tab.keyboard.press("Escape");
      await tab.waitForFunction(`!document.querySelector('[data-slot="sheet-content"]')`);
      expect(new URL(tab.url()).search).toBe("");
    } finally {
      await browser.close();
    }
  });

  it("folds the chat column from the bar and keeps it folded across a reload, counts the Inbox on its tile, and floats the open approval over the list, in Chrome", async (test) => {
    const chrome = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
    if (!existsSync(chrome)) test.skip("no Chrome: install Google Chrome or set CHROME_PATH");
    const browser = await launchChrome({ executablePath: chrome, headless: true, defaultViewport: LAPTOP });
    try {
      const tab = await browser.newPage();
      const inbox = new URL("/inbox?show=waiting", app.url).href;
      await tab.goto(inbox);
      await tab.evaluate((key) => localStorage.setItem(key, "tester"), ACTOR_KEY);
      await tab.goto(inbox, { waitUntil: "networkidle0" });
      // In the page, as strings: this file is typed for Node, without the DOM's globals.
      const run = <T>(code: string) => tab.evaluate(code) as Promise<T>;
      // The Inbox's tile counts every approval waiting, as the page's title does.
      const badge = 'nav[aria-label="Sections"] a[href="/inbox"] [data-slot="badge"]';
      await tab.waitForSelector(badge);
      const pending = await run<string>(`document.querySelector("h1 span").textContent`);
      expect(Number(pending)).toBeGreaterThan(0);
      expect(await run(`document.querySelector('${badge}').textContent`)).toBe(`${pending} waiting`);
      // The chat column, open by default, takes room beside the page: the approval sits above the list.
      const chatButton = '::-p-aria(Chat[role="button"])';
      const expanded = () =>
        run(
          `[...document.querySelectorAll("button")].find((b) => b.textContent === "Chat").getAttribute("aria-expanded")`,
        );
      const float = '[data-slot="card"].shadow-lg[role="region"]';
      const placed = () => run(`getComputedStyle(document.querySelector('${float}')).position`);
      expect(await tab.$("aside#chat")).not.toBeNull();
      expect(await placed()).toBe("static");
      // Chat folds it, and says so in a cookie the server reads: a reload renders it folded at
      // once, the page's own HTML without the column.
      await tab.click(chatButton);
      await tab.waitForFunction(`!document.getElementById("chat")`);
      expect(await expanded()).toBe("false");
      expect(await run("document.cookie")).toContain("sanoma_chat=closed");
      const reloaded = await tab.reload({ waitUntil: "networkidle0" });
      expect(await reloaded!.text()).not.toContain('id="chat"');
      expect(await tab.$("aside#chat")).toBeNull();
      expect(await expanded()).toBe("false");
      // With the room, the open approval floats over the list's right; a row opens its own.
      expect(await placed()).toBe("absolute");
      const second = await run<{ href: string; title: string }>(`(() => {
        const row = document.querySelectorAll('section[aria-label="Waiting"] li a')[1];
        row.click();
        return { href: row.getAttribute("href"), title: row.querySelector("span + span > span").textContent };
      })()`);
      await tab.waitForFunction(`location.pathname + location.search === ${JSON.stringify(second.href)}`);
      await tab.waitForSelector(`${float}[aria-label="${second.title}"]`);
      // Chat unfolds it again.
      await tab.click(chatButton);
      await tab.waitForSelector("aside#chat");
      expect(await run("document.cookie")).toContain("sanoma_chat=open");
      // Never set, on a window too narrow to have it beside the page: folded, not over the page.
      await run(`document.cookie = "sanoma_chat=; path=/; max-age=0"`);
      await tab.setViewport({ width: 900, height: 800 });
      await tab.reload({ waitUntil: "networkidle0" });
      await tab.waitForFunction(`!document.getElementById("chat")`);
      expect(await expanded()).toBe("false");
      expect(await run("document.cookie")).not.toContain("sanoma_chat");
      // Still never set, it follows the window: wide enough again, it sits beside the page.
      await tab.setViewport(LAPTOP);
      await tab.waitForSelector("aside#chat");
      expect(await expanded()).toBe("true");
    } finally {
      await browser.close();
    }
  });

  it("lists the installed connectors alone when npm cannot be searched, and says so", async () => {
    npmSearchFails(() => HttpResponse.error());
    const { text } = await page("/connectors");
    expect(text).toContain(">Ghost<");
    expect(text).toContain("npm could not be reached, so only the installed connectors show.");
    expect(text).not.toContain(">Acme<");
  });

  it("renders a connector's page: its links, each operation's contract, phrases and scenarios, and who uses it", async () => {
    const blogPage = await page("/connectors/ghost");
    expect(blogPage.status).toBe(200);
    expect(blogPage.html).toMatch(/<h1[^>]*>(<img[^>]*>)+Ghost<\/h1>/);
    expect(blogPage.text).toContain("<title>Ghost · Sanoma</title>");
    expect(blogPage.html).toContain('href="https://www.npmjs.com/package/@sanoma-ai/connector-ghost"');
    expect(blogPage.html).toContain("<code>ghost.post.create</code>");
    expect(blogPage.text).toContain("<code>Given a post titled {title} exists</code>");
    expect(blogPage.text).not.toContain("Its connector attaches no fake.");
    // The scenario that names the operation, linking to its workflow's New run in Sandbox mode with it chosen.
    expect(blogPage.html).toContain('href="/workflows/announce?new=true&amp;scenario=Launch+on+time"');
    // What each scenario does with an operation: create is seeded and expected; publish fails
    // once ("Publish retried"), is expected, and must not be called ("Copy rejected").
    for (const label of ["seeds", "fails", "expects", "must not call"]) expect(blogPage.text).toContain(`>${label}<`);
    expect(blogPage.html).toContain('href="/workflows/announce"');

    // A vendor with resource operations only has nothing to fake: no notice that it has no fake.
    // Its resource types are named.
    const githubPage = await page("/connectors/github");
    expect(githubPage.text).not.toContain("Its connector attaches no fake.");
    expect(githubPage.html).toMatch(/Resources: <\/span>Branch protection rule, Repository, Team membership</);

    // One with workflow operations whose connector attaches no fake says so, once.
    const chatPage = await page("/connectors/chat");
    expect(chatPage.text.match(/Its connector attaches no fake\./g)).toHaveLength(1);

    const missing = await page("/connectors/nope");
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("No connector nope");
  });

  it("renders a workflow's page: its tabs, the graph with About floating over it, its source under Code, New run behind ?new, and not-found for one that does not exist", async () => {
    const found = await page("/workflows/announce");
    expect(found.status).toBe(200);
    // Its title under the Workflows crumb, its name beside it.
    expect(found.html).toMatch(
      /<nav aria-label="Breadcrumb"[^>]*><ol[^>]*><li[^>]*><a[^>]*href="\/workflows"[^>]*>Workflows<\/a>/,
    );
    expect(found.html).toMatch(/<h1[^>]*>Announce a launch<\/h1><\/div><code[^>]*>announce<\/code>/);
    expect(found.text).toContain("<title>Announce a launch · Sanoma</title>");
    // The page takes the column's full width (`staticData.wide`); other pages keep the reading width.
    expect(found.html).toContain('data-wide="true"');
    expect((await page("/connectors")).html).not.toContain("data-wide=");
    // Its views are tabs, each a URL (`?view=`), with how many runs and scenarios; the Graph shows.
    const { body: runs } = await runsOf({ workflow: "announce", limit: 50 });
    expect(tabs(found.html)).toEqual([
      { label: "Graph", href: "/workflows/announce", count: undefined, selected: true },
      { label: "Runs", href: "/workflows/announce?view=runs", count: runs.length, selected: false },
      { label: "Code", href: "/workflows/announce?view=code", count: undefined, selected: false },
      { label: "Scenarios", href: "/workflows/announce?view=scenarios", count: 3, selected: false },
    ]);
    // The graph's card, drawn in the browser: a skeleton until then.
    expect(found.html).toMatch(/role="region" aria-label="Graph"/);
    expect(found.html).toMatch(/<div data-slot="skeleton"[^>]*aria-label="Loading the graph"/);
    // Over it, the inspector, with nothing selected: About, what it may call, which closes.
    expect(floats(found.html)).toEqual(["Inspector"]);
    expect(found.html).toMatch(/<h2>About</);
    expect(found.html).toMatch(/<h3[^>]*>Starts<\/h3><p>By hand<\/p>/);
    expect(found.html).toMatch(/<h3[^>]*>Operations it may call<\/h3>/);
    expect(found.html).toMatch(/<button[^>]*aria-label="Close"/);
    // The source waits behind Code, and no tab is a Ledger: the workflow's page has no run.
    expect(found.html).not.toMatch(/<pre[^>]*>[^<]*ctx\.ghost\.post\.create\(/);
    expect(found.html).not.toMatch(/role="tab"[^>]*>Ledger</);
    const code = await page("/workflows/announce?view=code");
    expect(tabNamed(code.html, "Code")?.selected).toBe(true);
    expect(code.html).toMatch(/<pre[^>]*>[^<]*ctx\.ghost\.post\.create\(/);
    // About floats over the graph alone: the code has the card to itself until a node is picked.
    expect(floats(code.html)).toEqual([]);
    // Each tab keeps the rest of the search.
    expect(tabNamed((await page("/workflows/announce?runs=sandbox")).html, "Code")?.href).toBe(
      "/workflows/announce?runs=sandbox&view=code",
    );
    // New run is a link in the header, to the Graph's inspector; no form until then. No Run here:
    // it would link to this page. Nothing here goes to the Start page.
    expect(linkTag(found.html, "New run")).toMatch(/data-slot="button"[^>]*href="\/workflows\/announce\?new=true"/);
    expect(linkTag(code.html, "New run")).toMatch(/href="\/workflows\/announce\?new=true"/);
    expect(found.html).not.toContain('id="field-title"');
    expect(linkTag(found.html, "Run")).toBeUndefined();
    expect(found.html).not.toContain('href="/start?workflow=');

    // ?new: the New run card in the inspector, live: Live vendors and Sandbox, and the vendors
    // it calls for real; its Close drops ?new. A bare ?new, typed by hand, opens it too.
    for (const path of ["/workflows/announce?new=true", "/workflows/announce?new"]) {
      const opened = await page(path);
      expect(opened.status, path).toBe(200);
      expect(opened.html, path).toMatch(/<h2>New run</);
      expect(opened.html, path).toContain('id="field-title"');
    }
    const newRun = await page("/workflows/announce?new");
    expect(newRun.html).not.toMatch(/<h2>About</);
    expect(newRun.html).not.toMatch(/<fieldset[^>]*disabled/);
    expect(newRun.html).toMatch(
      /<a[^>]*href="\/workflows\/announce"[^>]*><svg[^>]*>(?:(?!<\/a>)[\s\S])*Close<\/span><\/a>/,
    );
    // A date-time is its ISO text until the browser shows it in its own time zone: empty here.
    const launchAt = newRun.html.match(/<input[^>]*id="field-launchAt"[^>]*>/)?.[0];
    expect(launchAt).toContain('type="text"');
    expect(launchAt).toContain('value=""');
    // Each mode is a link; Sandbox opens the first scenario.
    expect(linkTag(newRun.html, "Live vendors")).toContain('aria-current="page"');
    const sandboxLink = linkTag(newRun.html, "Sandbox");
    expect(sandboxLink).toContain('href="/workflows/announce?new=true&amp;scenario=Launch+on+time"');
    expect(sandboxLink).not.toContain("aria-current");
    expect(newRun.text).toContain("Calls Bluesky, Ghost, Resend for real");
    expect(newRun.text).toContain(">Start run<");
    expect(newRun.text).not.toContain("Nothing leaves Sanoma");

    // Scenarios: a row each, the one `?scenario=` names floating with Sandbox run.
    const scenarioTab = await page("/workflows/announce?view=scenarios&scenario=Launch+on+time");
    expect(tabNamed(scenarioTab.html, "Scenarios")?.selected).toBe(true);
    expect(floats(scenarioTab.html)).toEqual(["Launch on time"]);
    expect(linkTag(scenarioTab.html, "Sandbox run")).toContain(
      'href="/workflows/announce?scenario=Launch+on+time&amp;new=true"',
    );

    const missing = await page("/workflows/nope");
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("No workflow nope");
  });

  it("renders a sandbox run: its badge, its checks and its seeding, and its badge in the runs", async () => {
    const run = await page(`/workflows/announce/runs/${sandboxId}`);
    expect(run.status).toBe(200);
    expect(run.text).toContain("sandbox · Launch on time");
    expect(run.html).toMatch(/<h2[^>]*>Checks<\/h2>/);
    expect(run.text).toContain("resend.broadcast.send was called");
    expect(run.text).toContain("Seeded 1 from scenario “Launch on time”");
    const runs = await page("/workflows/announce?view=runs");
    expect(runs.text).toContain("sandbox · Launch on time");
  });

  it("renders a page compact while its cookie says so: the graph lower, and the chat column as its own cookie says", async () => {
    // Comfortable without the cookie: #app unmarked.
    const comfortable = await page("/workflows/announce");
    expect(comfortable.html).toContain('<div id="app">');

    // Compact: #app marked (style.css's `--pane-tall`, the graph box's height, is lower there).
    // The chat column follows its own cookie.
    const compact = await page("/workflows/announce", app.url, {
      headers: { cookie: "sanoma_density=compact; sanoma_chat=closed" },
    });
    expect(compact.status).toBe(200);
    expect(compact.html).toContain('<div id="app" data-density="compact">');
    expect(compact.html).toMatch(
      /class="h-\(--pane-tall\)"><div class="size-full"><div data-slot="skeleton"[^>]*aria-label="Loading the graph"/,
    );
    const stylesheet = /href="(\/assets\/style-[^"]+\.css)"/.exec(compact.html)?.[1];
    expect(stylesheet).toBeDefined();
    const css = await (await fetch(new URL(stylesheet!, app.url))).text();
    expect(css).toMatch(/#app\[data-density=compact\]\{[^}]*--pane-tall:440px/);
    expect(chatOpen(compact.html)).toBe(false);
  });

  it("renders the chat column folded while its cookie says so, from the first paint: the bar alone beside the page", async () => {
    const folded = await page(`/workflows/announce/runs/${runId}`, app.url, {
      headers: { cookie: "sanoma_chat=closed" },
    });
    expect(folded.status).toBe(200);
    expect(chatOpen(folded.html)).toBe(false);
    expect(folded.html).not.toContain('id="chat"');
    expect(folded.html).not.toContain('aria-label="Message the agent"');
    // The bar's sections remain, the current one lit.
    expect(barLink(folded.html, "/workflows")).toContain('aria-current="page"');
    expect(barLink(folded.html, "/inbox")).not.toContain("aria-current");
    // Open, said so or by default: anything else in the cookie reads as open.
    for (const cookie of ["sanoma_chat=open", "sanoma_chat=nonsense"]) {
      const open = await page("/resources", app.url, { headers: { cookie } });
      expect(chatOpen(open.html), cookie).toBe(true);
      expect(open.html, cookie).toContain('<aside id="chat" aria-label="Chat"');
    }
  });

  it("answers any other path with the app's not-found page", async () => {
    const res = await fetch(new URL("/nonexistent", app.url));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('<div id="app">');
  });

  it("answers a path under /api like any other unknown path", async () => {
    for (const path of ["/api/config", "/api/runs?status=waiting"]) {
      const res = await page(path);
      expect(res.status, path).toBe(404);
      expect(res.html, path).toContain('<div id="app">');
    }
  });

  it("renders a run under its workflow's crumbs, named by its id's start, and answers a run that does not exist with not-found", async () => {
    const found = await page(`/workflows/announce/runs/${runId}`);
    expect(found.status).toBe(200);
    // Its header: the crumbs Workflows / the workflow, "Run" and its id's first 8 characters,
    // its status with a dot, who started it and when.
    const short = runId.slice(0, 8);
    const header = found.text.match(/<header[^>]*>([\s\S]*?)<\/header>/)?.[1];
    expect(header).toMatch(
      /<nav aria-label="Breadcrumb"[^>]*><ol[^>]*><li[^>]*><a[^>]*href="\/workflows"[^>]*>Workflows<\/a>(?:(?!<\/li>)[\s\S])*<\/li><li[^>]*><a[^>]*href="\/workflows\/announce"[^>]*>Announce a launch<\/a>/,
    );
    expect(header).toMatch(new RegExp(`<h1[^>]*>Run ${short}</h1>`));
    expect(header).toMatch(
      /<span data-slot="badge"[^>]*id="run-status"[^>]*><span aria-hidden="true"[^>]*><\/span>finished<\/span>/,
    );
    expect(header).toContain("Ålice · <time");
    expect(found.text).toContain(`<title>Run ${short} · Sanoma</title>`);
    // React Flow draws the graph in the browser only: the server renders its card and a
    // skeleton. Under it the Ledger tab is open, each row it has a node for with Show in graph;
    // the source waits behind Code.
    expect(found.html).toMatch(/role="region" aria-label="Graph"/);
    expect(found.html).toMatch(/<div data-slot="skeleton"[^>]*aria-label="Loading the graph"/);
    expect(found.html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Ledger</);
    expect(found.html).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*>Code</);
    expect(found.html).toContain('aria-label="Ledger"');
    expect(found.html).toMatch(/<button[^>]*aria-label="Show in graph"/);
    expect(found.html).not.toMatch(/<pre[^>]*>[^<]*ctx\.ghost\.post\.create\(/);
    // A finished run has no banner.
    expect(found.text).not.toContain("Waiting on");
    // The inspector floating over the graph, with nothing selected: the run's facts and its approvals.
    expect(floats(found.html)).toEqual(["Inspector"]);
    expect(found.html).toMatch(/<h2>Run</);
    expect(found.html).toMatch(/<dt[^>]*>Run id<\/dt><dd[^>]*><code[^>]*>/);
    // The header's New run opens it on the workflow's page; no Run.
    expect(linkTag(found.html, "New run")).toMatch(/data-slot="button"[^>]*href="\/workflows\/announce\?new=true"/);
    expect(linkTag(found.html, "Run")).toBeUndefined();
    // The workflow's own approval covers no operation, and says so.
    expect(found.html).toMatch(/Lets through<\/dt><dd[^>]*><span[^>]*>no operation by itself/);
    // ?new on a run's page, an older link: New run in place of the run's facts.
    const newRun = await page(`/workflows/announce/runs/${runId}?new`);
    expect(newRun.html).toContain('id="field-title"');
    expect(newRun.html).not.toMatch(/<h2>Run</);

    // A run waiting on its approval: the banner says on whom and for what, with a button to its node.
    const started = await postRun({ workflow: "announce", input: input("Banner") });
    await waitFor(
      () => detail(started.body.runId),
      (d) => d.run.status === "waiting",
    );
    const waiting = await page(`/workflows/announce/runs/${started.body.runId}`);
    expect(waiting.text).toMatch(/Waiting on marketing-lead for “[^”]+”<button[^>]*>Show approval<\/button>/);
    // The inspector sets out the approval with Approve and Reject, not in a card of its own.
    expect(waiting.html).toMatch(/<button[^>]*>(<svg.*?<\/svg>)?Approve<\/button>/);
    expect(waiting.html).not.toContain('data-slot="card-footer"');
    const missing = await page("/workflows/announce/runs/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("No run does-not-exist");
  });

  it("lists a workflow's runs under its Runs tab, filtered by ?runs=, the one ?run= names floating over them", async () => {
    const { body: runs } = await runsOf({ workflow: "announce", limit: 50 });
    const sandbox = runs.filter((r) => r.sandbox !== undefined).map((r) => r.runId);
    expect(sandbox).toContain(sandboxId);
    // Every run, newest first, each row opening it over the list (`?run=`), the rest of the search kept.
    const all = await page("/workflows/announce?view=runs");
    expect(all.status).toBe(200);
    expect(tabNamed(all.html, "Runs")).toMatchObject({ count: runs.length, selected: true });
    expect(runRows(all.text)).toEqual(runs.map((r) => r.runId));
    expect(all.html).toMatch(/<select[^>]*aria-label="Show runs"/);
    expect(floats(all.html)).toEqual([]);
    const filtered = await page("/workflows/announce?view=runs&runs=sandbox");
    expect(filtered.status).toBe(200);
    expect(runRows(filtered.text).toSorted()).toEqual(sandbox.toSorted());
    expect(filtered.html).toContain(`href="/workflows/announce?view=runs&amp;runs=sandbox&amp;run=${sandboxId}"`);
    expect(tabNamed(filtered.html, "Runs")?.count).toBe(sandbox.length);
    // The filter is the page's: the bar's links do not carry it.
    expect(barLink(filtered.html, "/workflows")).toBeDefined();
    expect(filtered.html).not.toContain('href="/workflows?runs=');
    expect(filtered.html).not.toContain('href="/inbox?runs=');

    // ?run=: the run over the list, marked in it: its status, who started it, its input and
    // ledger, and Open run, its page. Its Close drops ?run= alone.
    const opened = await page(`/workflows/announce?view=runs&runs=sandbox&run=${sandboxId}`);
    const short = sandboxId.slice(0, 8);
    expect(floats(opened.html)).toEqual([`Run ${short}`]);
    // Only the tab showing is the current page.
    expect(opened.html).not.toMatch(/<a [^>]*role="tab"[^>]*aria-selected="false"[^>]*aria-current="page"/);
    // The other tabs keep the filter, not the run, which only Runs shows.
    expect(tabNamed(opened.html, "Graph")?.href).toBe("/workflows/announce?runs=sandbox");
    expect(opened.html).toMatch(new RegExp(`<tr[^>]*data-state="selected"[^>]*>(?:(?!</tr>)[\\s\\S])*${short}`));
    const float = opened.text.slice(opened.text.indexOf(`aria-label="Run ${short}"`));
    expect(float).toContain(">sandbox · Launch on time<");
    expect(float).toMatch(/<dt[^>]*>Started by<\/dt><dd[^>]*>tester<\/dd>/);
    expect(float).toMatch(/<h3[^>]*>Input<\/h3>/);
    expect(float).toMatch(/<h3[^>]*>Ledger<\/h3>/);
    expect(linkTag(float, "Open run")).toContain(`href="/workflows/announce/runs/${sandboxId}"`);
    expect(float).toContain('href="/workflows/announce?view=runs&amp;runs=sandbox"');
    // One the server cannot read is the card's to say, once the browser has asked.
    const nope = await page("/workflows/announce?view=runs&run=nope");
    expect(floats(nope.html)).toEqual(["Run nope"]);
    expect(nope.html).toContain('aria-label="Loading the run"');

    // Sandbox is a pick from the latest runs, so none there is all it can say.
    expect((await page("/workflows/drift?view=runs&runs=sandbox")).text).toContain(
      "No sandbox runs among the latest 50",
    );
    // Failed is the server's to pick (`status=failed`), not a pick from the latest 50, so an
    // older failed run is not lost behind them.
    const { body: failed } = await runsOf({ workflow: "announce", status: "failed", limit: 50 });
    expect(failed).not.toEqual([]);
    const failedPage = await page("/workflows/announce?view=runs&runs=failed");
    expect(failedPage.status).toBe(200);
    expect(runRows(failedPage.text)).toEqual(failed.map((r) => r.runId));
    // The tab's query as the server hands it to the browser: its hash, keys sorted.
    expect(failedPage.html).toContain(String.raw`\"limit\":50,\"status\":\"failed\",\"workflow\":\"announce\"`);
  });

  it("serves the built assets, hashed ones as immutable, and nothing outside them", async () => {
    const [asset] = readdirSync(join(distDir, "client", "assets")).filter((f) => f.endsWith(".js"));
    const res = await fetch(new URL(`/assets/${asset}`, app.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("cache-control")).toMatch(/immutable/);
    // A raw request, so the client doesn't normalise the dots away.
    expect(await rawStatus(app.url, "/assets/%2e%2e/%2e%2e/package.json")).not.toBe(200);
  });

  it("keeps the runtime out of the browser bundle", () => {
    const dir = join(distDir, "client", "assets");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      // Nor the scenarios' Gherkin parser and faker, which only the server loads.
      expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/DBOSClient|systemDatabaseUrl|@cucumber|faker/);
      // Nor Postgres's client, which reads and writes the credentials.
      expect(file).not.toMatch(/^pg[-.]/);
      expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(
        /pg-protocol|pg-pool|sanoma_credentials|pg_notify/,
      );
    }
  });

  it("refuses requests addressed to a name other than this machine's", async () => {
    expect(await rawStatus(app.url, "/workflows", { host: "attacker.example:80" })).toBe(403);
  });

  it("answers an ingress route before the login, whatever name it is addressed to, by its exact path, and 405 for another method", async () => {
    expect(await rawStatus(app.url, "/machine?n=3", { host: "10.0.0.7:3000" })).toBe(204);
    const res = await fetch(new URL("/machine?n=4", app.url));
    expect([res.status, res.headers.get("x-query")]).toEqual([204, "?n=4"]);
    // Another method is refused; another path is the login's, which refuses the host.
    const post = await fetch(new URL("/machine", app.url), { method: "POST" });
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET"]);
    expect(await rawStatus(app.url, "/machine/", { host: "10.0.0.7:3000" })).toBe(403);
  });

  it("answers a prefix ingress route at its path and every path under it, and no path that merely starts like it", async () => {
    for (const path of ["/machines", "/machines/a/b"]) {
      const res = await fetch(new URL(`${path}?x=1`, app.url), { method: "PUT" });
      expect([res.status, await res.text()]).toEqual([200, path]);
    }
    expect(await rawStatus(app.url, "/machines/a", { host: "10.0.0.7:3000" })).toBe(200);
    expect(await rawStatus(app.url, "/machinesx", { host: "10.0.0.7:3000" })).toBe(403);
  });

  it("answers a host's probe at /healthz before the login, whatever name it is addressed to", async () => {
    expect(await rawStatus(app.url, "/healthz", { host: "10.0.0.7:3000" })).toBe(200);
    const res = await fetch(new URL("/healthz?from=docker", app.url));
    expect([res.status, await res.text()]).toEqual([200, "ok\n"]);
  });
  // wave 2 B: New run
  it("renders a workflow's page in Sandbox mode: the scenario's input read-only, and the scenario", async () => {
    const launch = (await scenarios(ctx)).scenarios.find((s) => s.name === SCENARIO)!;
    // Only the fields its When sets: the rest are made up.
    expect(launch.input).toMatchObject({ title: "Acme Pro", launchAt: "2030-01-01T09:00:00Z" });
    const { title } = launch.input as { title: string };

    const pane = await page("/workflows/announce?new&scenario=Launch+on+time");
    expect(pane.status).toBe(200);
    // One disabled fieldset around the fields: the browser disables every control in it.
    expect(pane.html).toMatch(/<fieldset[^>]*disabled=""[^>]*>(?:(?!<\/fieldset>)[\s\S])*id="field-title"/);
    expect(pane.html).toMatch(new RegExp(`<input[^>]*id="field-title"[^>]*value="${title}"`));
    // A date-time as the scenario gives it, not in this process's time zone.
    expect(pane.html).not.toContain('type="datetime-local"');
    expect(pane.html).toMatch(/<input[^>]*id="field-launchAt"[^>]*value="2030-01-01T09:00:00Z"/);
    expect(linkTag(pane.html, "Sandbox")).toContain('aria-current="page"');
    expect(linkTag(pane.html, "Live vendors")).not.toContain("aria-current");
    expect(pane.html).toMatch(/<select[^>]*aria-label="Scenario"/);
    expect(pane.text).toContain(
      "Nothing leaves Sanoma: the scenario supplies the input and the fakes answer the calls.",
    );
    expect(pane.text).not.toContain("for real");
    expect(pane.text).toContain(">Start sandbox run<");
    // The scenario's text is behind its disclosure, closed until opened in the browser.
    expect(pane.html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>(<svg.*?<\/svg>)?Scenario<\/button>/);

    // An unknown scenario is still Sandbox, and the page says so in the form's place.
    const unknown = await page("/workflows/announce?new&scenario=nope");
    expect(unknown.status).toBe(200);
    expect(unknown.text).toContain("No scenario named “nope”");
    expect(unknown.html).toMatch(/<select[^>]*aria-label="Scenario"/);
    expect(unknown.html).not.toContain('id="field-title"');

    // A search value the router reads as a number is no scenario: Live.
    const numeric = await page("/workflows/announce?new&scenario=123");
    expect(numeric.status).toBe(200);
    expect(numeric.text).toContain(">Start run<");
  });
});

// One more app on the file's database, to test four things a deployment may change: its own
// login, listening on every interface, a ledger the worker does not write to, and data
// files, one of them broken.
describe("resources and drift", () => {
  let driftRun: string;
  let report: DriftReport;
  beforeAll(async () => {
    // GitHub and Stripe hold what the data files declare, but for one field each, and one rule is gone.
    company.seed();
    company.github.override("repository", "website", { has_wiki: true });
    company.stripe.override("product", "prod_SanomaFixturePro", { name: "Sanoma Professional" });
    company.github.remove("branch_protection", "website:main");
    // Started as any workflow is, with its input: nothing.
    const started = await startAs({ workflow: "drift", input: {} }, { actor: "alice" });
    if (started.status) throw new Error(`startRunFn failed with ${started.status}: ${started.body.error}`);
    driftRun = started.body.runId;
    const done = await waitFor(
      () => detail(driftRun),
      (d) => d.run.status === "finished",
    );
    const finished = done.ledger.at(-1);
    report = (finished?.type === "run.finished" ? finished.output : undefined) as DriftReport;
  });

  it("lists drift runs by workflow, started as the actor", async () => {
    const { body } = await runsOf({ workflow: "drift", limit: 1 });
    expect(body).toMatchObject([
      { runId: driftRun, workflow: "drift", status: "finished", startedBy: { id: "alice" } },
    ]);
    expect((await runsOf({ workflow: "nope" })).body).toEqual([]);
  });

  it("reads each workflow's latest run, by name", async () => {
    const last = await lastRuns(ctx);
    expect(Object.keys(last).toSorted()).toEqual(["announce", "drift"]);
    const { body: announced } = await runsOf({ workflow: "announce", limit: 1 });
    expect(last.announce?.runId).toBe(announced[0]?.runId);
    expect(last.drift?.runId).toBe(driftRun);
  });

  it("refuses a drift run given any input: it reads the data files itself", async () => {
    const forged = await startAs(
      { workflow: "drift", input: { resources: [{ id: "x#y", vendor: "github", type: "repository", name: "x" }] } },
      { actor: "alice" },
    );
    expect(forged.status).toBe(400);
    expect(forged.body.code).toBe("invalid_input");
  });

  it("finds two drifted, one gone, one clean and two absent", () => {
    expect(report.resources.filter((r) => r.status === "drifted")).toEqual([
      expect.objectContaining({
        id: "resources/billing/stripe.ts#pro",
        fields: [{ path: "name", desired: "Sanoma Pro", actual: "Sanoma Professional" }],
      }),
      expect.objectContaining({
        id: "resources/identity/github.ts#website",
        fields: [{ path: "has_wiki", desired: false, actual: true }],
      }),
    ]);
    expect(report.resources.filter((r) => r.status === "gone").map((r) => r.id)).toEqual([
      "resources/identity/github.ts#websiteMain",
    ]);
    expect(report.resources.filter((r) => r.status === "clean")).toHaveLength(1);
    // Not in the lockfile: a Stripe object nothing finds, and a rule GitHub finds by its identity.
    const absent = report.resources.filter((r) => r.status === "absent");
    expect(absent.map(({ id, found }) => ({ id, found }))).toEqual([
      { id: "resources/billing/stripe.ts#events", found: undefined },
      { id: "resources/identity/rules.ts#docsMain", found: "BPR_docs:main" },
    ]);
  });

  it("adopts a drifted field: the vendor's value into the data file, committed through the source", async () => {
    // A root of its own, so the other tests read the fixture's files as they are.
    const root = mkdtempSync(join(tmpdir(), "sanoma-adopt-"));
    cpSync(join(appRoot, "resources"), join(root, "resources"), { recursive: true });
    const commits: unknown[] = [];
    const source: Source = {
      root,
      commit: (made) => {
        commits.push(made);
        return { revision: "0123456789abcdef" };
      },
      head: () => "0123456789abcdef",
    };
    const adopting: AppContext = { ...ctx, resolved: { ...ctx.resolved, root }, source };
    const alice = { id: "alice" };
    const github = "resources/identity/github.ts";
    const before = readFileSync(join(root, github), "utf8");
    const website = { runId: driftRun, id: `${github}#website`, paths: ["has_wiki"] };
    expect(await adopt(adopting, alice, website)).toEqual({ file: github, revision: "0123456789abcdef" });
    expect(readFileSync(join(root, github), "utf8")).toBe(before.replace("has_wiki: false", "has_wiki: true"));
    expect(commits).toEqual([{ paths: [github], message: "Adopt has_wiki of website from github", author: "alice" }]);

    // Without a source, the file is written and nothing committed.
    const stripe = "resources/billing/stripe.ts";
    const pro = { runId: driftRun, id: `${stripe}#pro`, paths: ["name"] };
    expect(await adopt({ ...adopting, source: undefined }, alice, pro)).toEqual({ file: stripe });
    expect(readFileSync(join(root, stripe), "utf8")).toContain('name: "Sanoma Professional",');
    expect(commits).toHaveLength(1);

    // A commit that fails says so, with the file written.
    const failing: Source = {
      ...source,
      commit: () => {
        throw new Error("index.lock exists");
      },
    };
    await expect(adopt({ ...adopting, source: failing }, alice, pro)).rejects.toMatchObject({
      status: 500,
      body: { error: `Wrote ${stripe}, but could not commit it: index.lock exists` },
    });

    // Only a field the run found drifted, and only while the file still declares it.
    await expect(adopt(adopting, alice, { ...website, paths: ["name"] })).rejects.toMatchObject({
      status: 400,
      body: { error: `name of ${github}#website has not drifted` },
    });
    await expect(adopt(adopting, alice, { ...website, id: `${github}#docs` })).rejects.toMatchObject({ status: 404 });
    writeFileSync(join(root, github), before.replaceAll("website", "site"));
    await expect(adopt(adopting, alice, website)).rejects.toMatchObject({
      status: 409,
      body: { error: `Could not adopt into ${github}: The data file declares no resource website` },
    });
    expect(commits).toHaveLength(1);
  });

  it("renders each resource with its drift badge, the fields that differ, and a link to the run", async () => {
    const resources = await page("/resources");
    expect(resources.status).toBe(200);
    expect(resources.html).toMatch(/<h1[^>]*>Resources<\/h1>/);
    expect(resources.text).toContain("<title>Resources · Sanoma</title>");
    expect(resources.text).toContain(`href="/workflows/drift/runs/${driftRun}"`);
    expect(resources.text).toContain('href="/resources?resource=resources%2Fidentity%2Fgithub.ts%23website"');
    expect(resources.text.match(/>drifted: 1 field</g)).toHaveLength(2);
    expect(resources.text.match(/>gone</g)).toHaveLength(1);
    expect(resources.text.match(/>clean</g)).toHaveLength(1);
    expect(resources.text.match(/>absent</g)).toHaveLength(1);
    expect(resources.text.match(/>absent: found unbound</g)).toHaveLength(1);
    expect(resources.text).toContain("2 drifted");
    // The collections, each linked to its declaration.
    expect(resources.text).toContain(">Collections<");
    expect(resources.text).toContain('href="/resources?resource=resources%2Fdata.ts%23outbound"');
    // A button to adopt each drifted field.
    expect(resources.text.match(/>Adopt</g)).toHaveLength(2);
    // Each drifted field, as declared and as the vendor holds it.
    expect(resources.text).toMatch(/<code>has_wiki<\/code>.*?<code>false<\/code>.*?<code>true<\/code>/s);
    expect(resources.text).toMatch(
      /<code>name<\/code>.*?<code>&quot;Sanoma Pro&quot;<\/code>.*?<code>&quot;Sanoma Professional&quot;<\/code>/s,
    );
    expect(resources.html).toContain('href="/resources"');
    // A resource's declaration in its file, from the search: as plain text on the server.
    const chosen = await page("/resources?resource=resources%2Fidentity%2Fgithub.ts%23website");
    expect(chosen.text).toMatch(/<h2[^>]*><code>resources\/identity\/github\.ts<\/code><\/h2>/);
  });

  it("lists the built-in drift workflow like any other, labelled built-in, and starts it from its page", async () => {
    const workflows = await page("/workflows");
    expect(workflows.text).toContain(">built-in<");
    expect(workflows.text).toMatch(/<td[^>]*><div[^>]*><a[^>]*href="\/workflows\/drift"/);
    const start = await page("/workflows/drift?new=true");
    expect(start.status).toBe(200);
    expect(start.text).toContain(">Start run<");
  });
  it("tabs the overview by filter, All runs last, and heads it with New workflow, each view its own link", async () => {
    const overview = await page("/workflows");
    expect(tabs(overview.html)).toEqual([
      { label: "All", href: "/workflows", count: 4, selected: true },
      { label: "Waiting on you", href: "/workflows?filter=waiting", count: 0, selected: false },
      { label: "Failed last run", href: "/workflows?filter=failed", count: 0, selected: false },
      { label: "Built-in", href: "/workflows?filter=builtin", count: 3, selected: false },
      { label: "All runs", href: "/workflows?view=runs", count: undefined, selected: false },
    ]);
    expect(overview.html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>(<svg.*?<\/svg>)?New workflow<\/button>/);
    const runs = await page("/workflows?view=runs&status=failed");
    expect(tabNamed(runs.html, "All runs")?.selected).toBe(true);
    expect(tabNamed(runs.html, "All")).toMatchObject({ href: "/workflows", selected: false });
    // The bar's Workflows is lit on both.
    for (const shown of [overview, runs]) expect(barLink(shown.html, "/workflows")).toContain('aria-current="page"');
    expect(runs.html).toContain('aria-label="Status"');
  });

  it("lists every workflow in a table: how it starts, the vendors it calls, its last run and what waits, and a tab per filter", async () => {
    const workflows = await page("/workflows");
    const row = (name: string) =>
      workflows.text.match(
        new RegExp(`<tr[^>]*><td[^>]*><div[^>]*><a[^>]*href="/workflows/${name}"(?:(?!</tr>)[\\s\\S])*</tr>`),
      )?.[0];
    const announceRow = row("announce");
    expect(announceRow).toContain(">By hand<");
    for (const title of ["Ghost", "Resend", "Bluesky"]) expect(announceRow).toMatch(new RegExp(`/>${title}</span>`));
    // The tests before leave announce with runs, so it has a last run.
    expect(announceRow).toMatch(/>(finished|failed|waiting|running|sleeping)/);
    // ?filter=builtin keeps drift, apply and call (the config has a collection) alone.
    const builtin = await page("/workflows?filter=builtin");
    expect(builtin.html).toMatch(/<td[^>]*><div[^>]*><a[^>]*href="\/workflows\/drift"/);
    expect(builtin.html).toMatch(/<td[^>]*><div[^>]*><a[^>]*href="\/workflows\/apply"/);
    expect(builtin.html).toMatch(/<td[^>]*><div[^>]*><a[^>]*href="\/workflows\/call"/);
    expect(builtin.html).not.toMatch(/<td[^>]*><div[^>]*><a[^>]*href="\/workflows\/announce"/);
    expect(tabNamed(builtin.html, "Built-in")).toMatchObject({ count: 3, selected: true });
    expect(builtin.html).not.toMatch(/<a [^>]*role="tab"[^>]*aria-selected="false"[^>]*aria-current="page"/);
  });

  it("orders the overview's workflows by their last run, under a box to find one by", async () => {
    const { text, html } = await page("/workflows");
    expect(html).toMatch(/<input[^>]*type="search"[^>]*aria-label="Find a workflow"/);
    // No name on the server under the default resolver: nothing is waiting on you, so the one
    // run last comes first, and those never run after both.
    const last = await lastRuns(ctx);
    const at = (name: string) => text.indexOf(`href="/workflows/${name}"`);
    const [first, second] = ["announce", "drift"].toSorted((a, b) => last[b]!.createdAt - last[a]!.createdAt);
    expect(at(first!)).toBeGreaterThan(0);
    expect(at(second!)).toBeGreaterThan(at(first!));
    for (const never of ["apply", "call"]) expect(at(never), never).toBeGreaterThan(at(second!));
    expect(text).not.toContain("waiting on you</span>");
    // Only the overview finds: not Resources.
    expect((await page("/resources")).html).not.toContain('aria-label="Find a workflow"');
  });

  it("lists every run under All runs, linking each to its page, sandbox runs badged, and filters them by ?status= as getRuns does", async () => {
    const { body: finished } = await runsOf({ status: "finished" });
    expect(finished.length).toBeGreaterThan(0);
    // Each page's text, and the runs its table links to, by its search.
    const pages: Record<string, string> = {};
    for (const search of ["", "status=finished", "status=asleep"]) {
      const shown = await page(`/workflows?view=runs&${search}`);
      expect(shown.status, search).toBe(200);
      pages[search] = shown.text;
    }
    const rows = Object.fromEntries(
      Object.entries(pages).map(([search, text]) => [
        search,
        [...text.matchAll(/<a[^>]*href="\/workflows\/[^/"]+\/runs\/([^"?]+)"/g)].map(([, id]) => id).toSorted(),
      ]),
    );
    const all = pages[""]!;
    expect(all).toContain('aria-label="Status"');
    expect(rows[""]).toEqual(expect.arrayContaining([runId, driftRun]));
    expect(all).toContain(`sandbox · ${SCENARIO}`);
    expect(pages["status=finished"]).toMatch(/<option[^>]*value="finished"[^>]*selected=""/);
    expect(rows["status=finished"]).toEqual(finished.map((run) => run.runId).toSorted());
    // One that is not a status reads as any; a status with no runs says so.
    expect(rows["status=asleep"]).toEqual(rows[""]);
    expect((await page("/workflows?view=runs&status=cancelled")).text).toContain("No runs with that status");
  });

  it("filters All runs by ?workflow=, and shows the filter with its removal", async () => {
    const { body: announced } = await runsOf({ workflow: "announce" });
    const shown = await page("/workflows?view=runs&workflow=announce");
    expect(shown.status).toBe(200);
    const linked = [...shown.text.matchAll(/<a[^>]*href="\/workflows\/([^/"]+)\/runs\/([^"?]+)"/g)];
    expect(linked.map(([, workflow]) => workflow)).not.toContain("drift");
    expect(new Set(linked.map(([, , id]) => id))).toEqual(new Set(announced.map((run) => run.runId)));
    expect(shown.text).toMatch(/Workflow: <code>announce<\/code>/);
    // Its removal keeps the view and drops the workflow.
    expect(shown.html).toMatch(
      /<a[^>]*href="\/workflows\?view=runs"[^>]*><svg[^>]*>(?:(?!<\/a>)[\s\S])*Any workflow<\/span><\/a>/,
    );
    // A workflow with no runs says so.
    expect((await page("/workflows?view=runs&workflow=nope")).text).toContain("No runs of that workflow");
  });

  it("counts in each workflow's row the approvals its runs wait on", async () => {
    const started = await postRun({ workflow: "announce", input: input("Pill") });
    await waitFor(
      () => detail(started.body.runId),
      (d) => d.run.status === "waiting",
    );
    const { body: waiting } = await runsOf({ status: "waiting", workflow: "announce", limit: RUNS_LIMIT.max });
    const pending = waiting.reduce((n, run) => n + run.approvals.filter((a) => a.status === "pending").length, 0);
    expect(pending).toBeGreaterThan(0);
    const workflows = await page("/workflows");
    // Every approval waiting, on anyone: no name on the server, so none for you.
    expect(workflows.text).toContain(`>${pending} approval${pending === 1 ? "" : "s"}</span>`);
    // Drift asks no one.
    expect(workflows.text.match(/>\d+ approvals?<\/span>/g)).toHaveLength(1);
  });
});

/**
 * A login that says who is asking from a test header, the way a hosted deployment reads its
 * session, and serves a sign-out route of its own.
 */
const hostedLogin: LoginProvider = {
  name: "test",
  check() {},
  resolveActor(request) {
    const who = request.headers.get("x-test-user");
    if (who === "boom") throw new Error("the session store is down");
    return who ? { id: who, groups: ["marketing"] } : undefined;
  },
  handle: (request) =>
    new URL(request.url).pathname === "/auth/test/signout" ? new Response(null, { status: 204 }) : undefined,
  signOut: "/auth/test/signout",
};

describe("an app configured otherwise", () => {
  let dir: string;
  let other: App;
  /** The other app's context, as its server functions get it. */
  let otherCtx: AppContext;
  const warned: string[] = [];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sanoma-app-ledger-"));
    mkdirSync(join(dir, "resources"));
    // The same app ("sanoma", as no package.json names it), on its own root: its data files are these.
    const GH = `import { github } from "@sanoma-ai/connector-github/resources";\n`;
    writeFileSync(join(dir, "resources", "good.ts"), `${GH}export const web = github.repository({ name: "web" });\n`);
    writeFileSync(join(dir, "resources", "bad.ts"), `${GH}export const docs = github.repository({ name: 1 });\n`);
    // A directory nothing has written to yet: the worker keeps its records in memory.
    const otherConfig = { ...config, ledger: jsonlLedger(join(dir, "ledger")), root: dir };
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warned.push(args.join(" ")));
    other = await startApp(otherConfig, { host: "0.0.0.0", login: hostedLogin });
    warn.mockRestore();
    otherCtx = await contextOf(otherConfig, hostedLogin);
  });
  afterAll(async () => {
    await other?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("boots with broken data files: lists the resources it could read, and the problems", async () => {
    expect(warned).toEqual([
      expect.stringMatching(/^sanoma app: the config's files have problems.*\n {2}resources\/bad\.ts:2:1: /s),
    ]);
    const body = withoutSources(otherCtx.description);
    expect(body.resources.map((r) => r.id)).toEqual(["resources/good.ts#web"]);
    expect(body.problems).toEqual([
      {
        file: "resources/bad.ts",
        line: 2,
        column: 1,
        message: expect.stringMatching(/^export const docs: github\.repository: /),
      },
    ]);
  });

  it("boots with policies that do not hold, and says so, as they refuse everything", async () => {
    const root = mkdtempSync(join(tmpdir(), "sanoma-app-policy-"));
    mkdirSync(join(root, "policies"));
    writeFileSync(join(root, "policies", "bad.cedar"), "forbid (principal, action, resource) when { context.nope };\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const refusing = await startApp({ ...config, root });
      // The policy it has refuses, and the page says so.
      const pages = Promise.all([
        page("/workflows", refusing.url),
        page("/permissions", refusing.url, { headers: { cookie: "sanoma_actor=ada" } }),
      ]);
      const [workflows, permissions] = await pages.finally(() => refusing.close());
      expect(workflows.text).toMatch(
        /data-slot="alert-description"[^>]*><code>policies\/\*\.cedar<\/code> do not hold, so every operation call and run start is refused/,
      );
      expect(permissions.text).toMatch(
        /data-slot="alert-description"[^>]*><code>policies\/\*\.cedar<\/code> do not hold, so every operation call and run start is refused/,
      );
      expect(warn.mock.calls.flat().join("\n")).toMatch(/files have problems.*\n {2}policies\/bad\.cedar:1:\d+: /s);
    } finally {
      warn.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows the data files' problems on the resources page, and the resources it could read", async () => {
    const resources = await page("/resources", other.url);
    expect(resources.status).toBe(200);
    expect(resources.text).toContain("1 problem in the data files: their resources are left out");
    expect(resources.text).toMatch(/<code>resources\/bad\.ts:2:1<\/code> export const docs: github\.repository: /);
    expect(resources.text).toContain("resources/good.ts#web");
  });

  const post = (user?: string) =>
    startAs(
      { workflow: "announce", input: input("Hosted") },
      { app: otherCtx, headers: user ? { "x-test-user": user } : {} },
    );
  const read = () => detail(runId, otherCtx);
  /** The Inbox as the deployment's user `user` sees it. */
  const inboxAs = async (user: string) =>
    (await fetch(new URL("/inbox", other.url), { headers: { "x-test-user": user } })).text();
  /** The Workflows page as the deployment's user `user` sees it. */
  const workflowsAs = async (user: string) =>
    (await fetch(new URL("/workflows", other.url), { headers: { "x-test-user": user } })).text();

  describe("with a login provider", () => {
    it("says who is asking itself, and where to sign out", () => {
      expect([saysWho(ctx), signOutUrl(ctx)]).toEqual([false, undefined]);
      expect([saysWho(otherCtx), signOutUrl(otherCtx)]).toEqual([true, "/auth/test/signout"]);
    });

    it("gives the login every request first", async () => {
      const res = await fetch(new URL("/auth/test/signout", other.url), { method: "POST" });
      expect(res.status).toBe(204);
    });

    it("starts runs as the principal it resolves, groups included", async () => {
      const started = await post("sso-user");
      expect(started.status).toBeUndefined();
      const run = await waitFor(
        () => detail(started.body.runId),
        (d) => d.run.startedBy !== undefined,
      );
      expect(run.run.startedBy).toEqual({ id: "sso-user", groups: ["marketing"] });
    });

    it("refuses a change it names nobody for without mentioning the header it does not read", async () => {
      const anonymous = await post();
      expect(anonymous.status).toBe(400);
      expect(anonymous.body.code).toBe("invalid_input");
      expect(anonymous.body.error).not.toMatch(/x-sanoma-actor/);
    });

    it("renders who the deployment says is asking, and never asks for a name", async () => {
      const res = await fetch(new URL("/workflows", other.url), { headers: { "x-test-user": "sso-user" } });
      const html = await res.text();
      // The user menu's trigger: the deployment's name for you, and whose name it is. Nothing
      // asks for a name or says one is kept here (the menu, with no "Change name" either,
      // renders only once opened).
      expect(html).toMatch(
        />sso-user<\/span><span[^>]*>, marketing<\/span><span[^>]*>Signed in by the deployment<\/span>/,
      );
      expect(html).not.toContain("Who are you?");
      expect(html).not.toContain("Name kept in this browser");
    });

    it("opens the Inbox on For you: the approvals the principal it resolves may decide", async () => {
      // The earlier tests leave announce's runs waiting on marketing-lead.
      const lead = await inboxAs("marketing-lead");
      expect(tabNamed(lead, "For you")).toMatchObject({ count: expect.any(Number), selected: true });
      expect(tabNamed(lead, "For you")?.count).toBeGreaterThan(0);
      expect(inboxRows(lead).length).toBeGreaterThan(0);
      const someoneElse = await inboxAs("sso-user");
      expect(tabNamed(someoneElse, "For you")).toMatchObject({ count: 0, selected: true });
      expect(someoneElse).toContain("Nothing is waiting for you");
    });

    it("puts the workflows waiting on the principal first in the overview, with their counts", async () => {
      const lead = (await workflowsAs("marketing-lead")).replaceAll("<!-- -->", "");
      expect(tabNamed(lead, "Waiting on you")?.count).toBe(1);
      // This app's root has no policies: no Permissions in the bar, and the overview says so.
      expect(barLink(lead, "/permissions")).toBeUndefined();
      expect(lead).toContain("No policy: every operation call is allowed");
      // Announce first, its count beside its title, though drift ran last.
      const rows = lead.slice(lead.indexOf("<tbody"));
      expect(rows.indexOf('href="/workflows/announce"')).toBeLessThan(rows.indexOf('href="/workflows/drift"'));
      expect(rows).toMatch(/href="\/workflows\/announce"(?:(?!<\/tr>)[\s\S])*>\d+ waiting on you</);
      // The Waiting column counts every approval waiting, on anyone.
      expect(rows).toMatch(/href="\/workflows\/announce"(?:(?!<\/tr>)[\s\S])*>\d+ approvals?<\/span>/);
      // Nothing waits on sso-user.
      const someoneElse = (await workflowsAs("sso-user")).replaceAll("<!-- -->", "");
      expect(tabNamed(someoneElse, "Waiting on you")?.count).toBe(0);
      expect(someoneElse).not.toContain(" waiting on you<");
    });

    it("answers a resolver that throws with a 500, and logs why", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const failed = await post("boom");
      expect(failed.status).toBe(500);
      expect(failed.body.error).toBe("Something went wrong");
      expect(logged.mock.calls).toEqual([
        [
          expect.stringContaining("a server function failed"),
          expect.objectContaining({ message: "Could not tell who you are: the session store is down" }),
        ],
      ]);
    });
  });

  describe("on every interface", () => {
    it("answers a request addressed to any name, since it was asked to listen beyond this machine", async () => {
      const base = `http://127.0.0.1:${new URL(other.url).port}`;
      expect(await rawStatus(base, "/workflows", { host: "sanoma.example:80" })).toBe(200);
    });
  });

  describe("reading a jsonl ledger", () => {
    it("says a run that has started has no records there: the app reads another ledger than the worker", async () => {
      const body = await read();
      expect(body.ledger).toEqual([]);
      expect(body.ledgerError).toBe(
        "No records for a run that has started; is the app reading the same ledger as the worker?",
      );
      const html = await page(`/workflows/announce/runs/${runId}`, other.url);
      expect(html.status).toBe(200);
      expect(html.text).toContain("is the app reading the same ledger as the worker?");
    });

    it("shows why it cannot read a corrupt ledger, and logs it for the operator once", async () => {
      mkdirSync(join(dir, "ledger"), { recursive: true });
      writeFileSync(join(dir, "ledger", `${encodeURIComponent(runId)}.jsonl`), "not json\n");
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await read();
      // Read again, as the page's poll does: logged once for the run and the failure.
      await read();
      expect(result.ledger).toEqual([]);
      expect(result.ledgerError).toMatch(/corrupt ledger line/);
      expect(logged).toHaveBeenCalledOnce();
      expect(String(logged.mock.calls[0]?.[0])).toContain(`could not read the ledger of run ${runId}`);
    });
  });
});

describe("an app whose config no longer has a workflow", () => {
  // The file's database, where announce has runs, read by a config without announce.
  let retired: App;
  beforeAll(async () => {
    retired = await startApp({ ...config, workflows: [] }, { port: 0 });
  });
  afterAll(async () => {
    await retired?.close();
  });

  it("keeps the retired workflow's page while it has runs: its name, its runs, and no Run", async () => {
    const about = await page("/workflows/announce", retired.url);
    expect(about.status).toBe(200);
    expect(about.html).toMatch(/<h1[^>]*>announce<\/h1>/);
    expect(about.text).toMatch(
      /This config has no workflow named <code>announce<\/code>\. Its past runs are under <a[^>]*href="\/workflows\/announce\?view=runs"[^>]*>Runs<\/a>\./,
    );
    // Its tabs: the Graph, which says so, and its Runs; no Code or Scenarios to show.
    expect(tabs(about.html).map((t) => t.label)).toEqual(["Graph", "Runs"]);
    // A view whose tab is not there shows the Graph.
    expect(tabNamed((await page("/workflows/announce?view=code", retired.url)).html, "Graph")?.selected).toBe(true);
    const runs = await page("/workflows/announce?view=runs", retired.url);
    expect(runs.html).toContain(`href="/workflows/announce?view=runs&amp;run=${runId}"`);
    expect((await page("/workflows/announce?new", retired.url)).html).not.toContain('id="field-title"');
    expect(linkTag(about.html, "New run")).toBeUndefined();
    // A run of it has no New run either: there is nothing to start.
    expect(linkTag((await page(`/workflows/announce/runs/${runId}`, retired.url)).html, "New run")).toBeUndefined();
  });

  it("renders a run of it with only the workflow's name, and its old URL leads there", async () => {
    const run = await page(`/workflows/announce/runs/${runId}`, retired.url);
    expect(run.status).toBe(200);
    // Its graph, from the ledger alone, and its ledger; the Code tab says why it has no source.
    expect(run.html).toMatch(/role="region" aria-label="Graph"/);
    expect(run.html).toMatch(/role="tab"[^>]*>Ledger</);
    expect(run.html).toContain('aria-label="Ledger"');
    const old = await fetch(new URL(`/runs/${runId}`, retired.url), { redirect: "manual" });
    expect(old.status).toBe(307);
    expect(old.headers.get("location")?.endsWith(`/workflows/announce/runs/${runId}`)).toBe(true);
  });

  it("answers a workflow with neither a config entry nor runs with not-found", async () => {
    const missing = await page("/workflows/nope", retired.url);
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("No workflow nope");
  });
});

describe("an app whose drivers declare environment variables", () => {
  // Made-up variables and values: nothing here is a credential.
  const URL_VAR = "SANOMA_TEST_GHOST_URL";
  const KEY_VAR = "SANOMA_TEST_GHOST_KEY";
  const SITE = "https://madeup-site.example.test";
  const KEY = "key_madeupvalue";
  const env = z.object({
    [URL_VAR]: z.url().describe("the made-up site's URL"),
    [KEY_VAR]: z
      .string()
      .regex(/^key_[a-z]+$/, "a made-up key, key_<letters>")
      .describe("a made-up key"),
  });
  let declaring: App;
  /** The declaring app's context, as its server functions get it. */
  let declaringCtx: AppContext;
  /** `setCredentialFn` and `clearCredentialFn` on the declaring app, as tester. */
  const set = (data: unknown) => setAs(data, { actor: "tester", app: declaringCtx });
  const clear = (data: unknown) => clearAs(data, { actor: "tester", app: declaringCtx });
  /** `getCredentials` on the declaring app. */
  const statuses = () => credentials(declaringCtx);
  beforeAll(async () => {
    vi.stubEnv(URL_VAR, SITE);
    vi.stubEnv(KEY_VAR, undefined);
    // The ghost driver (the first connector's), with an env: startApp does not refuse what startWorker would.
    const connectors = [
      withSetup(config.connectors[0]!, { driver: () => ({ ...blog.driver, env }) }),
      ...config.connectors.slice(1),
    ];
    declaring = await startApp({ ...config, connectors }, { port: 0 });
    declaringCtx = await contextOf({ ...config, connectors });
    // The table outlives a run of the tests.
    await clear({ name: KEY_VAR });
    await clear({ name: URL_VAR });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await declaring?.close();
  });

  it("says on /connectors how many variables a vendor needs, and nothing for a vendor that declares none", async () => {
    const connectors = await page("/connectors", declaring.url);
    expect(connectors.text).toContain("2 operations · used by 1 workflow · needs 1 variable");
    expect(connectors.text).not.toContain("configured");
    expect((await page("/connectors")).text).not.toMatch(/needs \d+ variable|configured/);
  });

  it("lists each variable on the connector's page with its status and Set, or that the environment sets it", async () => {
    const blogPage = await page("/connectors/ghost", declaring.url);
    expect(blogPage.html).toMatch(/>Credentials<\/h2>/);
    expect(blogPage.text).toMatch(
      new RegExp(`<code>${URL_VAR}</code>.*?>set<.*?the made-up site&#x27;s URL.*?set in the environment`),
    );
    expect(blogPage.text).toMatch(new RegExp(`<code>${KEY_VAR}</code>.*?>missing<.*?a made-up key.*?>Set</button>`));
    // One Set: the environment's variable has no controls.
    expect(blogPage.text.match(/>(Set|Replace|Clear)<\/button>/g)).toEqual([">Set</button>"]);
    expect(blogPage.html).not.toContain(SITE);
    // A vendor whose drivers declare nothing has no such section.
    expect((await page("/connectors/resend", declaring.url)).html).not.toMatch(/>Credentials</);
  });

  it("carries the statuses in getCredentials, not the config's description, never a value", async () => {
    const body = withoutSources(declaringCtx.description);
    expect(body.vendors.ghost).not.toHaveProperty("credentials");
    const found = await statuses();
    expect(Object.keys(found)).toEqual(["ghost"]);
    expect(found.ghost).toEqual([
      { name: URL_VAR, description: "the made-up site's URL", optional: false, status: "set", source: "environment" },
      { name: KEY_VAR, description: "a made-up key", optional: false, status: "missing" },
    ]);
    expect(JSON.stringify([body, found])).not.toContain(SITE);
  });

  it("refuses a value the variable's schema refuses, a name no driver declares, and an anonymous change, without the value", async () => {
    const VALUE = "key_NOT-LOWER";
    const invalid = await set({ name: KEY_VAR, value: VALUE });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      code: "invalid_input",
      issues: [expect.objectContaining({ path: ["value"] })],
    });
    expect(JSON.stringify(invalid.body)).not.toContain(VALUE);

    const undeclared = await set({ name: "SANOMA_TEST_UNDECLARED", value: KEY });
    expect(undeclared.status).toBe(400);
    expect(undeclared.body).toMatchObject({
      code: "invalid_input",
      issues: [expect.objectContaining({ path: ["name"] })],
    });
    expect(JSON.stringify(undeclared.body)).not.toContain(KEY);
    const empty = await set({ name: KEY_VAR, value: "" });
    expect(empty.body.issues?.[0]).toMatchObject({
      path: ["value"],
      message: "Enter a value",
    });

    const anonymous = await setAs({ name: KEY_VAR, value: KEY }, { app: declaringCtx });
    expect(anonymous.status).toBe(400);
    expect((await statuses()).ghost?.[1]?.status).toBe("missing");
  });

  it("stores a value as the actor, says who set it on the page, then clears it", async () => {
    // It succeeds, and nothing comes back: never the value.
    expect(await set({ name: KEY_VAR, value: KEY })).toEqual({ body: undefined });
    const [, key] = (await statuses()).ghost!;
    expect(key).toMatchObject({ name: KEY_VAR, status: "set", source: "stored", setBy: "tester" });

    const blogPage = await page("/connectors/ghost", declaring.url);
    expect(blogPage.text).toMatch(new RegExp(`<code>${KEY_VAR}</code>.*?>set<.*?set by tester · <time`));
    expect(blogPage.text.match(/>(Set|Replace|Clear)<\/button>/g)).toEqual([">Replace</button>", ">Clear</button>"]);
    expect((await page("/connectors", declaring.url)).text).toContain("· configured");
    for (const html of [blogPage.html, JSON.stringify(await statuses())]) expect(html).not.toContain(KEY);

    expect(await clear({ name: KEY_VAR })).toEqual({ body: undefined });
    expect((await statuses()).ghost?.[1]).toEqual({
      name: KEY_VAR,
      description: "a made-up key",
      optional: false,
      status: "missing",
    });
  });
});

describe("startApp", () => {
  it("refuses to listen beyond this machine without a login", async () => {
    await expect(startApp(config, { host: "0.0.0.0" })).rejects.toThrow(
      /^The app has no login, so it listens on this machine only, not 0\.0\.0\.0/,
    );
    expect(() => loopbackLogin().check("::1")).not.toThrow();
  });

  it("refuses an ingress route at no path, at /healthz, or at a path another has", async () => {
    await expect(ingressAt("/wake?x")).rejects.toThrow(/has no query and is not \/healthz, unlike "\/wake\?x"/);
    await expect(ingressAt("wake")).rejects.toThrow(
      'An ingress route\'s path starts with /, has no query and is not /healthz, unlike "wake"',
    );
    await expect(ingressAt("/healthz")).rejects.toThrow(/is not \/healthz, unlike "\/healthz"/);
    await expect(ingressAt("/wake", "/wake")).rejects.toThrow("Two ingress routes have the path /wake");
    await expect(startApp(config, { ingress: [{ ...machinesRoute, path: "/machines/" }] })).rejects.toThrow(
      'A prefix ingress route\'s path does not end with /, unlike "/machines/"',
    );
  });

  it("says to build the app when it is not built", async () => {
    const empty = mkdtempSync(join(tmpdir(), "sanoma-app-dist-"));
    try {
      await expect(startApp(config, { distDir: empty })).rejects.toThrow(/pnpm --filter @sanoma-ai\/app build/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("refuses a build without its client files, or with none in it, rather than serving pages with no script or style", async () => {
    const half = mkdtempSync(join(tmpdir(), "sanoma-app-dist-"));
    try {
      mkdirSync(join(half, "server"));
      writeFileSync(join(half, "server", "server.js"), "");
      const refusal = `The app is not built: ${join(half, "client")} is missing`;
      await expect(startApp(config, { distDir: half })).rejects.toThrow(refusal);
      mkdirSync(join(half, "client"));
      await expect(startApp(config, { distDir: half })).rejects.toThrow(refusal);
    } finally {
      rmSync(half, { recursive: true, force: true });
    }
  });

  it("reports both failures when neither the server entry nor the database works", async () => {
    const broken = mkdtempSync(join(tmpdir(), "sanoma-app-dist-"));
    try {
      mkdirSync(join(broken, "server"));
      mkdirSync(join(broken, "client"));
      writeFileSync(join(broken, "server", "server.js"), "");
      writeFileSync(join(broken, "client", "index.txt"), "");
      const err = await startApp({ ...config, databaseUrl: "not a url" }, { distDir: broken }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).errors).toHaveLength(2);
      expect((err as Error).message).toMatch(
        /^The app could not start: .*server\.js does not export a \{ fetch \} server entry; and Invalid URL/,
      );
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
