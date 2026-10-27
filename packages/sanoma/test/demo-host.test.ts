import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import { SanomaClient } from "@sanoma-ai/workflows";
import { collection } from "@sanoma-ai/workflows/data";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/demo-host.ts";
import { copyFixture, ensureBuilt, serving } from "./fixture.ts";

// Needs Postgres (`pnpm db:up`) with the right to make databases, and the packages' builds. The
// session host as `sanoma demo` runs it with `demo.sessions`: a child seeds the seed, each visitor
// gets a copy of it and a child of their own over it, by a cookie.

/** The fixture's collection, as the test's clients read and write it. */
const leads = collection({
  name: "leads",
  title: "Leads",
  key: "company",
  fields: { company: "text", stage: { enum: ["researched", "won"] } },
});

/** The fixture with its people, a collection, a workflow that waits on Ada, a world and a moment, and `demo`. */
function demoFixture(demo: string): string {
  const dir = copyFixture();
  const files: Record<string, string> = {
    "sanoma.config.ts": `import { ghost } from "@sanoma-ai/connector-ghost";
import { defineConfig } from "sanoma";

export default defineConfig({ connectors: [ghost], demo: ${demo} });
`,
    "resources/people.ts": `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada", name: "Ada" });
export const bo = sanoma.person({ id: "bo", name: "Bo" });
`,
    "resources/data.ts": `import { collection } from "sanoma/data";

export const leads = collection({
  name: "leads",
  title: "Leads",
  key: "company",
  fields: { company: "text", stage: { enum: ["researched", "won"] } },
});
`,
    "workflows/review.ts": `import { defineWorkflow, z } from "sanoma";
import { leads } from "../resources/data.ts";

export default defineWorkflow({
  name: "review",
  title: "Review a lead",
  trigger: "manual",
  input: z.object({ company: z.string().min(1) }),
  uses: [leads.save, "approval"],
  run: async (ctx, { company }) => {
    await ctx.approval(\`Contact \${company}?\`, { approver: "ada" });
    await ctx.data.leads.save({ record: { company, stage: "won" } });
    return { won: company };
  },
});
`,
    "scenarios/world.feature": `Feature: The world

  Scenario: The pipeline
    Given data.leads "Acme" has
      | stage | researched |
`,
    "scenarios/moments.feature": `Feature: Moments

  @moment(bo,/inbox)
  Scenario: Acme waits for review
    When review runs with
      | company | Acme |
`,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** The environment `sanoma demo` runs in: `sanoma demo` puts the demo on `<database>_demo`. */
const envOn = (suffix: string) => ({
  SANOMA_DATABASE_URL: testDatabaseUrl(suffix),
  SANOMA_APP_PORT: "0",
  // Ghost's variables unset: every vendor is its fake.
  GHOST_ADMIN_URL: "",
  GHOST_ADMIN_API_KEY: "",
});
const demoDatabase = (suffix: string) => `${new URL(testDatabaseUrl(suffix)).pathname.slice(1)}_demo`;

/** A database's oid, or undefined when it is not there. */
async function oidOf(database: string): Promise<number | undefined> {
  const url = new URL(testDatabaseUrl("x"));
  url.pathname = "/postgres";
  const conn = new Client({ connectionString: url.toString() });
  await conn.connect();
  try {
    const { rows } = await conn.query("SELECT oid::int FROM pg_database WHERE datname = $1", [database]);
    return rows[0]?.oid as number | undefined;
  } finally {
    await conn.end();
  }
}

/** A client of the fixture's on one session's copy. */
function clientOn(dir: string, database: string): Promise<SanomaClient> {
  const url = new URL(testDatabaseUrl("x"));
  url.pathname = `/${database}`;
  return SanomaClient.connect({
    root: dir,
    workflows: [],
    connectors: [],
    collections: [leads],
    databaseUrl: url.toString(),
  });
}

/** A visitor of the host at `url`: their cookies, kept from each answer, and a page's HTML as they see it. */
function visitor(url: string) {
  const jar = new Map<string, string>();
  const get = async (path: string) => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const res = await fetch(`${url}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
    for (const set of res.headers.getSetCookie()) {
      const [pair] = set.split(";");
      const [name, value] = pair!.split("=") as [string, string];
      jar.set(name, value);
    }
    return { status: res.status, html: (await res.text()).replaceAll("<!-- -->", "") };
  };
  return { get, session: () => jar.get(SESSION_COOKIE) };
}

/** The session the host's log said it took last: its id, the suffix of its copy's name. */
const lastTaken = (stderr: string) => [...stderr.matchAll(/session ([0-9a-f]{8}) taken/g)].at(-1)?.[1];

const WAITING = "Contact Acme?";

/** Each lead in a session's copy, with its stage. */
const records = async (client: SanomaClient) =>
  ((await client.call("data.leads.list", {}, { actor: "bo" })) as { key: string; record: { stage: string } }[]).map(
    (r) => `${r.key} ${r.record.stage}`,
  );

let dir = "";
beforeAll(ensureBuilt, 600_000);
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("sanoma demo with demo.sessions", () => {
  const clients: SanomaClient[] = [];
  afterAll(async () => {
    for (const client of clients) await client.close();
  });

  it("gives each visitor a copy of the seed: a moment approved in one still waits in the other, a record typed in one is not in the other, and past the cap they share one", async () => {
    dir = demoFixture("{ sessions: 2 }");
    const { url, stop, output } = await serving(dir, ["demo"], envOn("demo_host"));
    const database = demoDatabase("demo_host");
    try {
      expect(output().stderr).toContain(`a session per visitor, at most 2 at once, each a copy of ${database}_seed`);
      // Two visitors, two sessions: each lands at the moment as Bo, the moment waiting for Ada.
      const a = visitor(url);
      const entered = await a.get("/inbox?as=bo");
      expect(entered.status).toBe(303);
      const idA = lastTaken(output().stderr)!;
      const b = visitor(url);
      await b.get("/inbox?as=bo");
      const idB = lastTaken(output().stderr)!;
      expect(idB).not.toBe(idA);
      expect(b.session()).not.toBe(a.session());
      for (const v of [a, b]) {
        const inbox = await v.get("/inbox");
        expect(inbox.status).toBe(200);
        expect(inbox.html).toMatch(/You are<button[^>]*>Bo/);
        expect(inbox.html).toContain(WAITING);
      }

      // Ada approves in A's copy, and someone types a record there.
      const [inA, inB] = await Promise.all([
        clientOn(dir, `${database}_s_${idA}`),
        clientOn(dir, `${database}_s_${idB}`),
      ]);
      clients.push(inA, inB);
      const [run] = await inA.runs({ status: "waiting" });
      const [approval] = await inA.approvals(run!.runId);
      await inA.decide(run!.runId, { decision: "approve", by: { id: "ada" } }, approval!.id);
      expect(await inA.result(run!.runId)).toEqual({ won: "Acme" });
      await inA.call("data.leads.save", { record: { company: "Initech", stage: "researched" } }, { actor: "bo" });

      // In B's, the same run still waits, and neither the approval's save nor the record is there.
      expect(await inB.run(run!.runId)).toMatchObject({ status: "waiting" });
      expect(await records(inA)).toEqual(["Acme won", "Initech researched"]);
      expect(await records(inB)).toEqual(["Acme researched"]);
      // And each visitor's pages say so: the request goes to their own session's process.
      expect((await a.get("/inbox")).html).not.toContain(WAITING);
      expect((await b.get("/inbox")).html).toContain(WAITING);
      expect((await a.get("/data/leads")).html).toContain("Initech");
      expect((await b.get("/data/leads")).html).not.toContain("Initech");

      // A third visitor, past the cap: the shared instance, seeded as any demo, on the database itself.
      const c = visitor(url);
      await c.get("/inbox?as=bo");
      expect(c.session()).toBe("shared");
      expect((await c.get("/inbox")).html).toContain(WAITING);
    } finally {
      await stop();
    }
    // Every session dropped with the host; the seed kept for the next.
    expect(await oidOf(`${database}_s_${lastTaken(output().stderr)}`)).toBeUndefined();
    expect(await oidOf(`${database}_seed`)).toBeDefined();
  }, 240_000);

  it("seeds afresh beside a live session, leaving it as it is, and drops a session left idle", async () => {
    // A copy of the seed in 6 s, a new seed every 12 s.
    dir = demoFixture("{ sessions: 1, idle: 0.1, reseed: 0.2 }");
    const { url, stop, output } = await serving(dir, ["demo"], envOn("demo_swap"));
    const database = demoDatabase("demo_swap");
    try {
      const a = visitor(url);
      await a.get("/inbox?as=bo");
      const id = lastTaken(output().stderr)!;
      const first = a.session();
      const inA = await clientOn(dir, `${database}_s_${id}`);
      try {
        const [run] = await inA.runs({ status: "waiting" });
        const [approval] = await inA.approvals(run!.runId);
        await inA.decide(run!.runId, { decision: "approve", by: { id: "ada" } }, approval!.id);
        await inA.result(run!.runId);

        // The seed is rebuilt and renamed in while the visitor keeps using their session.
        const seed = await oidOf(`${database}_seed`);
        await waitFor(
          async () => {
            await a.get("/inbox");
            return output().stderr;
          },
          (stderr) => stderr.includes(`${database}_seed seeded afresh`),
          90_000,
        );
        expect(await oidOf(`${database}_seed`)).not.toBe(seed);
        expect(await oidOf(`${database}_seed_old`)).toBeUndefined();
        expect(a.session()).toBe(first);
        expect(await inA.run(run!.runId)).toMatchObject({ status: "finished" });
        expect((await a.get("/inbox")).html).not.toContain(WAITING);
      } finally {
        await inA.close();
      }

      // Left alone, the session is dropped; the visitor's next request gets a new one, from the new seed.
      await waitFor(
        () => oidOf(`${database}_s_${id}`),
        (oid) => oid === undefined,
        30_000,
      );
      expect(output().stderr).toContain(`session ${id} idle, dropped`);
      await a.get("/inbox?as=bo");
      expect(a.session()).not.toBe(first);
      expect(a.session()).not.toBe("shared");
      expect((await a.get("/inbox")).html).toContain(WAITING);
    } finally {
      await stop();
    }
  }, 240_000);
});
