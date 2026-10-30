import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt, testDatabaseUrl } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { resolveConfig, type SanomaConfig, type Source } from "@sanoma-ai/workflows";
import { describeConfig, readPeople } from "@sanoma-ai/workflows/describe";
import { executablePath, launch } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACTOR_COOKIE } from "../src/api.ts";
import type { AppContext } from "../src/context.ts";
import { type App, startApp } from "../src/index.ts";
import { admitting } from "../src/login/admission.ts";
import { loopbackLogin } from "../src/loopback.ts";
import { patch } from "../src/server/core.ts";

// Needs Postgres (`pnpm db:up`) and the built app, as data.test.ts does. People: `/people`, its
// tabs and table from the people file, a row's declaration form over the list, Save through
// `patch` into a checkout with no remote (a stub source that commits), and the same form as
// Hosting's Edit. The one test in a browser needs Google Chrome, or `CHROME_PATH`, and skips
// without either.

const appDir = fileURLToPath(new URL("..", import.meta.url));
const PEOPLE = "resources/people.ts";

// A root of its own: three people (one admin, one whose name the file computes), an agent acting
// for one, two groups; and another file declaring one the type refuses, its problem People's.
const root = mkdtempSync(join(tmpdir(), "sanoma-people-"));
mkdirSync(join(root, "resources"));
writeFileSync(
  join(root, PEOPLE),
  `import { sanoma } from "sanoma/resources";

const CY = "Cy Chen";

export const ada = sanoma.person({ id: "ada", name: "Ada Ortiz", email: "ada@example.test" });
export const bo = sanoma.person({ id: "bo", name: "Bo Lin", github: "bo-lin" });
export const cy = sanoma.person({ id: "cy", name: CY });
export const refundBot = sanoma.agent({ id: "refund-bot", onBehalfOf: bo });
export const admin = sanoma.group({ name: "admin", members: [ada] });
export const ops = sanoma.group({ name: "ops", members: [ada, bo, refundBot] });
`,
);
// A person the type refuses, made through a helper outside resources/: the description has its
// problem, and admission, which loads only the files that import the constructors themselves
// (\`mayDeclarePeople\`), still admits the people while it is there.
mkdirSync(join(root, "lib"));
writeFileSync(
  join(root, "lib/team.ts"),
  `import { sanoma } from "sanoma/resources";\n\nexport const person = sanoma.person;\n`,
);
writeFileSync(
  join(root, "resources/team.ts"),
  `import { person } from "../lib/team.ts";\n\nexport const broken = person({ id: "two words" });\n`,
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The commits the stub source was asked for. */
const commits: unknown[] = [];
/** A repository with no remote and no drafts: Save commits in the checkout. */
const source: Source = {
  root,
  commit: (made) => {
    commits.push(made);
    return { revision: "abcdef0123456789" };
  },
  head: () => "abcdef0123456789",
};

const config: SanomaConfig = { workflows: [], connectors: [], root };
const testApp = useTestApp(config, { databaseUrl: testDatabaseUrl("people") });
let app: App;

beforeAll(async () => {
  ensureBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
  app = await startApp(testApp.config, { port: 0, source });
}, 120_000);

afterAll(async () => {
  await app?.close();
});

/** A page as the server renders it for `actor` (the loopback login's cookie), comments between text parts gone. */
async function page(path: string, actor = "ada") {
  const res = await fetch(new URL(path, app.url), { headers: { cookie: `${ACTOR_COOKIE}=${actor}` } });
  return { status: res.status, html: (await res.text()).replaceAll("<!-- -->", "") };
}

/** The table's rows, each as the text of its cells. */
const rows = (html: string) =>
  [...html.matchAll(/<tr[^>]*data-slot="table-row"[^>]*>((?:(?!<\/tr>)[\s\S])*)<\/tr>/g)]
    .map(([, row]) => [...row!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => text(cell!)))
    .filter((cells) => cells.length > 0);
const text = (html: string) =>
  html
    .replace(/<\/(?:span|div)>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The context `startApp` hands a request, for calling the server core as the page's Save does. */
function context(): AppContext {
  return {
    resolved: resolveConfig(testApp.config),
    description: describeConfig(testApp.config),
    client: testApp.client,
    place: "this-computer",
    login: admitting(loopbackLogin(), () => readPeople(root)),
    source,
  };
}

describe("People", () => {
  it("lists the people with how they sign in and their groups, the tabs with counts, and the people file's problems", async () => {
    const { status, html } = await page("/people");
    expect(status).toBe(200);
    expect(html).toMatch(/<h1[^>]*>People<span[^>]*>3<\/span><\/h1>/);
    expect(html).toContain("<title>People · Sanoma</title>");
    // The tabs, each a link with how many it lists.
    expect(html).toMatch(/href="\/people\?show=people"[^>]*>People<span[^>]*>3<\/span>/);
    expect(html).toMatch(/href="\/people\?show=groups"[^>]*>Groups<span[^>]*>2<\/span>/);
    expect(html).toMatch(/href="\/people\?show=agents"[^>]*>Agents<span[^>]*>1<\/span>/);
    expect(rows(html)).toEqual([
      ["Ada Ortiz", "ada", "Email · ada@example.test", "admin ops", "resources/people.ts#ada"],
      ["Bo Lin", "bo", "GitHub · bo-lin", "ops", "resources/people.ts#bo"],
      ["Cy Chen", "cy", "cannot sign in", "none", "resources/people.ts#cy"],
    ]);
    // A row opens over the list; its declaration opens in its file on Hosting.
    expect(html).toContain('href="/people?show=people&amp;person=ada"');
    expect(html).toContain('href="/hosting?resource=resources%2Fpeople.ts%23ada"');
    // What is wrong in the people file, above the table.
    expect(html).toMatch(
      /problem in the data files(?:(?!<\/ul>)[\s\S])*resources\/team\.ts(?:(?!<\/ul>)[\s\S])*one word/,
    );
  });

  it("lists the groups with their members, and the agents with whom they act for", async () => {
    expect(rows((await page("/people?show=groups")).html)).toEqual([
      ["admin", "ada", "resources/people.ts#admin"],
      ["ops", "ada bo refund-bot", "resources/people.ts#ops"],
    ]);
    expect(rows((await page("/people?show=agents")).html)).toEqual([
      ["refund-bot", "refund-bot", "bo", "ops", "resources/people.ts#refundBot"],
    ]);
  });

  it("opens a row's declaration form over the list: its fields as declared, its identity and references read-only", async () => {
    const { html } = await page("/people?person=ada");
    const card = html.match(/<div[^>]*role="region"[^>]*aria-label="ada"[\s\S]*<\/form>/)?.[0];
    expect(card).toBeDefined();
    expect(card).toContain("resources/people.ts · export ada");
    expect(card).toMatch(/<input[^>]*id="field-name"[^>]*value="Ada Ortiz"/);
    expect(card).toMatch(/<input[^>]*id="field-email"[^>]*value="ada@example.test"/);
    expect(card).toMatch(/<input[^>]*id="field-github"[^>]*value=""/);
    // Who she is to the policy and the groups is the file's.
    expect(card).toMatch(/<fieldset disabled=""[^>]*>(?:(?!<\/fieldset>)[\s\S])*id="field-id"[^>]*value="ada"/);
    expect(card).toContain("Who it is to the policy and to the groups: change it in the file.");
    expect(card).toContain(">Save<");
    // A group's members name declared people: shown, not set here.
    const ops = (await page("/people?show=groups&person=ops")).html;
    expect(ops).toMatch(/<fieldset disabled=""[^>]*>(?:(?!<\/fieldset>)[\s\S])*Names another declared resource/);
    // A name no row of the tab has opens nothing.
    expect((await page("/people?person=nobody")).html).not.toContain('role="region"');
  });

  it("is Hosting's Edit on a declaration: the same form above its file", async () => {
    const closed = (await page(`/hosting?resource=${encodeURIComponent(`${PEOPLE}#bo`)}`)).html;
    expect(closed).toMatch(
      /<a [^>]*href="\/hosting\?resource=resources%2Fpeople\.ts%23bo&amp;edit=true"[^>]*>(?:(?!<\/a>)[\s\S])*Edit<\/a>/,
    );
    expect(closed).not.toContain('id="field-name"');
    const open = (await page(`/hosting?resource=${encodeURIComponent(`${PEOPLE}#bo`)}&edit=true`)).html;
    expect(open).toMatch(/<div[^>]*role="region"[^>]*aria-label="Edit bo"/);
    expect(open).toMatch(/<input[^>]*id="field-name"[^>]*value="Bo Lin"/);
  });

  it("saves through the function into the checkout and commits it, and refuses a people file to someone not in admin", async () => {
    const before = readFileSync(join(root, PEOPLE), "utf8");
    // Not in admin, and no remote to review it on: refused, the file as it was.
    await expect(
      patch(context(), { id: "bo" }, { at: { file: PEOPLE, export: "bo" }, fields: { name: "Bo L." } }),
    ).rejects.toMatchObject({
      status: 403,
      body: { error: `A change to ${PEOPLE} waits for an admin, and this company has no remote to review on` },
    });
    expect(readFileSync(join(root, PEOPLE), "utf8")).toBe(before);
    // A name the file computes is the code's.
    await expect(
      patch(context(), { id: "ada", groups: ["admin"] }, { at: { file: PEOPLE, export: "cy" }, fields: { name: "C" } }),
    ).rejects.toMatchObject({
      status: 409,
      body: { error: "the value of name is computed in the file", field: "name" },
    });
    // By an admin: written and committed.
    expect(
      await patch(
        context(),
        { id: "ada", groups: ["admin"] },
        { at: { file: PEOPLE, export: "bo" }, fields: { name: "Bo L." } },
      ),
    ).toEqual({ file: PEOPLE, revision: "abcdef0123456789" });
    expect(readFileSync(join(root, PEOPLE), "utf8")).toBe(before.replace('name: "Bo Lin"', 'name: "Bo L."'));
    expect(commits).toEqual([{ paths: [PEOPLE], message: "Change name of bo", author: "ada" }]);
    // The next page reads the description made again from the file as it now is: no restart.
    expect(rows((await page("/people")).html)[1]).toEqual([
      "Bo L.",
      "bo",
      "GitHub · bo-lin",
      "ops",
      "resources/people.ts#bo",
    ]);
    writeFileSync(join(root, PEOPLE), before);
    commits.length = 0;
  });

  it("saves from the form in Chrome: refused to someone not in admin, a computed field locked, saved by an admin", async (ctx) => {
    const chrome = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
    if (!existsSync(chrome)) ctx.skip("no Chrome: install Google Chrome or set CHROME_PATH");
    const before = readFileSync(join(root, PEOPLE), "utf8");
    const browser = await launch({ executablePath: chrome, headless: true });
    try {
      const as = async (actor: string, path: string) => {
        const tab = await browser.newPage();
        await tab.setViewport({ width: 1440, height: 900 });
        await tab.evaluateOnNewDocument((name) => localStorage.setItem("sanoma.actor", name), actor);
        await tab.goto(new URL(path, app.url).href, { waitUntil: "networkidle0" });
        return tab;
      };
      /** Types `value` over a field's text and saves. */
      const save = async (tab: Awaited<ReturnType<typeof as>>, field: string, value: string) => {
        await tab.click(field, { count: 3 });
        await tab.type(field, value);
        await tab.click('form[aria-label^="Declaration"] button[type="submit"]');
      };

      // bo is in no admin group, and there is no remote: the refusal shows on the form.
      const bo = await as("bo", "/people?person=bo");
      await save(bo, "#field-name", "Bo Bo");
      await bo.waitForSelector('[data-slot="alert"]::-p-text(waits for an admin)');
      expect(readFileSync(join(root, PEOPLE), "utf8")).toBe(before);

      // A name the file computes: its reason under it, and the field read-only from then on.
      const ada = await as("ada", "/people?person=cy");
      await save(ada, "#field-name", "Cy");
      await ada.waitForSelector("::-p-text(the value of name is computed in the file)");
      await ada.waitForSelector("#field-name:disabled");

      // An admin's Save is written and committed, and says so.
      await ada.goto(new URL("/people?person=bo", app.url).href, { waitUntil: "networkidle0" });
      await save(ada, "#field-name", "Bo Lin-Ito");
      await ada.waitForSelector("::-p-text(committed as abcdef0)");
      expect(readFileSync(join(root, PEOPLE), "utf8")).toContain('name: "Bo Lin-Ito"');
      expect(commits).toEqual([{ paths: [PEOPLE], message: "Change name of bo", author: "ada" }]);
    } finally {
      await browser.close();
      writeFileSync(join(root, PEOPLE), before);
    }
  }, 60_000);
});
