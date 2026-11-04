import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt, testDatabaseUrl } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { resolveConfig, type SanomaConfig, type Source } from "@sanoma-ai/workflows";
import { readPeople } from "@sanoma-ai/workflows/describe";
import { executablePath, launch } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ACTOR_COOKIE } from "../src/api.ts";
import type { AppContext, LoginProvider } from "../src/context.ts";
import { type App, startApp } from "../src/index.ts";
import { admitting } from "../src/login/admission.ts";
import { actorFromCookie, loopbackLogin } from "../src/loopback.ts";
import { patch } from "../src/server/local/writes.ts";
import { appSnapshot } from "../src/snapshot-build.ts";
import { invitePerson, peopleSignIns } from "../src/server/people.ts";

// Needs Postgres (`pnpm db:up`) and the built app, as data.test.ts does. People: `/people`, its
// tabs and table from the people file, a row's declaration form over the list, Save through
// `patch` into a checkout with no remote (a stub source that commits), and the same form as
// Hosting's Edit; on an app whose login mints invite links (a stub of the host's staff login), each
// row's Invite link and its card. The tests in a browser need Google Chrome, or `CHROME_PATH`, and
// skip without either.

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
const testApp = useTestApp(config, { databaseUrl: testDatabaseUrl("app_people") });
let app: App;
/** The same company on a login that says who is asking (the loopback's cookie) and mints invite links, as a host's does. */
let inviter: App;

/** A host's staff login, stubbed: who is asking from the cookie, and an invite link for an email. */
const inviting: LoginProvider = {
  name: "test",
  check() {},
  resolveActor: actorFromCookie,
  invite: async (email, { origin }) => ({
    url: `${origin}/auth/invite/tok-${email}`,
    expiresAt: new Date(Date.now() + 86_400_000),
  }),
};

beforeAll(async () => {
  ensureBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
  app = await startApp(testApp.config, { port: 0, source });
  inviter = await startApp(testApp.config, { port: 0, source, login: inviting });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await inviter?.close();
});

/** A page as the server renders it for `actor` (the loopback login's cookie), comments between text parts gone. */
async function page(path: string, actor = "ada", on = app) {
  const res = await fetch(new URL(path, on.url), { headers: { cookie: `${ACTOR_COOKIE}=${actor}` } });
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

/** Ada, as admitted: in admin. */
const ADA = { id: "ada", groups: ["admin", "ops"] };

/** The context `startApp` hands a request, for calling the server core as the page's Save does. */
async function context(): Promise<AppContext> {
  return {
    resolved: resolveConfig(testApp.config),
    snapshot: await appSnapshot(testApp.config, { source }),
    client: testApp.client,
    place: "this-computer",
    login: admitting(loopbackLogin(), () => readPeople(root)),
    local: { source },
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
      ["Ada Ortiz", "ada@example.test", "admin ops", "Email code · ada@…", "Never"],
      ["Bo Lin", "none", "ops", "GitHub · bo-lin", "Never"],
      ["Cy Chen", "none", "none", "cannot sign in", "Never"],
    ]);
    expect(html).toMatch(
      /<th[^>]*>Name<\/th><th[^>]*>Email<\/th><th[^>]*>Groups<\/th><th[^>]*>Signs in<\/th><th[^>]*>Last signed in<\/th><\/tr>/,
    );
    // On this machine the picker signs anyone in: no invite links, so no Actions.
    expect(html).not.toContain("Invite link");
    // A row opens over the list.
    expect(html).toContain('href="/people?show=people&amp;person=ada"');
    // What is wrong in the people file, above the table.
    expect(html).toMatch(
      /problem in the data files(?:(?!<\/ul>)[\s\S])*resources\/team\.ts(?:(?!<\/ul>)[\s\S])*one word/,
    );
  });

  it("says when each person last signed in and how, and mints an invite link only where the login makes them", async () => {
    await testApp.client.recordSignIn("cy", "github");
    await testApp.client.recordSignIn("cy", "code");
    const signIns = await peopleSignIns(await context());
    expect(signIns).toEqual({ invites: false, last: { cy: { at: expect.any(Number), method: "code" } } });
    expect(rows((await page("/people")).html)[2]).toEqual([
      "Cy Chen",
      "none",
      "none",
      "cannot sign in",
      expect.stringMatching(/ · email code$/),
    ]);
    // On this machine the picker signs anyone in: no invites.
    await expect(invitePerson(await context(), { id: "ada" }, "ada", "http://localhost")).rejects.toMatchObject({
      status: 409,
    });

    // A host's login mints them, for a declared person with an email.
    const invite = vi.fn<(email: string, at: { origin: string }) => Promise<{ url: string; expiresAt: Date }>>(
      async (email, { origin }) => ({
        url: `${origin}/auth/invite/tok-${email}`,
        expiresAt: new Date(0),
      }),
    );
    const base = await context();
    const hosted = { ...base, login: { ...base.login, invite } };
    expect((await peopleSignIns(hosted)).invites).toBe(true);
    // Only an admin hands one out: it signs its holder in as that person.
    await expect(
      invitePerson(hosted, { id: "bo", groups: ["ops"] }, "ada", "https://acme.example"),
    ).rejects.toMatchObject({
      status: 403,
    });
    expect(await invitePerson(hosted, ADA, "ada", "https://acme.example")).toEqual({
      url: "https://acme.example/auth/invite/tok-ada@example.test",
      expiresAt: new Date(0).toISOString(),
    });
    expect(invite).toHaveBeenCalledWith("ada@example.test", { origin: "https://acme.example", by: "ada" });
    await expect(invitePerson(hosted, ADA, "bo", "https://acme.example")).rejects.toMatchObject({
      status: 409,
    });
    await expect(invitePerson(hosted, ADA, "nobody", "https://acme.example")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("lists the groups with their members, and the agents with whom they act for, agents built in", async () => {
    const groups = (await page("/people?show=groups")).html;
    expect(rows(groups)).toEqual([
      ["admin", "ada", "resources/people.ts#admin"],
      ["ops", "ada bo refund-bot", "resources/people.ts#ops"],
      // The group the runtime puts every agent in, declared nowhere.
      ["agents (built in)", "refund-bot", "the runtime: every agent"],
    ]);
    // The tab counts the groups declared.
    expect(groups).toMatch(/href="\/people\?show=groups"[^>]*>Groups<span[^>]*>2<\/span>/);
    const agents = (await page("/people?show=agents&person=refund-bot")).html;
    expect(rows(agents)).toEqual([["refund-bot", "bo", "ops agents (built in)", "resources/people.ts#refundBot"]]);
    // Muted, beside the declared ones, in the table and on the open card.
    expect(agents.match(/title="The runtime puts every agent in it"/g)).toHaveLength(2);
  });

  it("opens a row's declaration form over the list: its fields as declared, its identity and references read-only", async () => {
    const { html } = await page("/people?person=ada");
    const card = html.match(/<div[^>]*role="region"[^>]*aria-label="ada"[\s\S]*<\/form>/)?.[0];
    expect(card).toBeDefined();
    expect(card).toContain("resources/people.ts · export ada");
    // Its declaration opens in its file on Hosting.
    expect(card).toContain('href="/hosting?resource=resources%2Fpeople.ts%23ada"');
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
      patch(await context(), { id: "bo" }, { at: { file: PEOPLE, export: "bo" }, fields: { name: "Bo L." } }),
    ).rejects.toMatchObject({
      status: 403,
      body: { error: `A change to ${PEOPLE} waits for an admin, and this company has no remote to review on` },
    });
    expect(readFileSync(join(root, PEOPLE), "utf8")).toBe(before);
    // A name the file computes is the code's.
    await expect(
      patch(
        await context(),
        { id: "ada", groups: ["admin"] },
        { at: { file: PEOPLE, export: "cy" }, fields: { name: "C" } },
      ),
    ).rejects.toMatchObject({
      status: 409,
      body: { error: "the value of name is computed in the file", field: "name" },
    });
    // By an admin: written and committed.
    expect(
      await patch(
        await context(),
        { id: "ada", groups: ["admin"] },
        { at: { file: PEOPLE, export: "bo" }, fields: { name: "Bo L." } },
      ),
    ).toEqual({ file: PEOPLE, revision: "abcdef0123456789" });
    expect(readFileSync(join(root, PEOPLE), "utf8")).toBe(before.replace('name: "Bo Lin"', 'name: "Bo L."'));
    expect(commits).toEqual([{ paths: [PEOPLE], message: "Change name of bo", author: "ada" }]);
    // The next page reads the description made again from the file as it now is: no restart.
    expect(rows((await page("/people")).html)[1]).toEqual(["Bo L.", "none", "ops", "GitHub · bo-lin", "Never"]);
    writeFileSync(join(root, PEOPLE), before);
    commits.length = 0;
  });

  it("gives each row an Invite link where the login mints them: for an admin, a person with an email", async () => {
    const { html } = await page("/people", "ada", inviter);
    expect(html).toMatch(/<th[^>]*>Last signed in<\/th><th[^>]*><span class="sr-only">Actions<\/span><\/th>/);
    const why = "Invite linkDeclare an email to make an invite link for them";
    expect(rows(html).map((cells) => cells.at(-1))).toEqual(["Invite link", why, why]);
    // Ada's opens the card; Bo and Cy have no email declared: disabled, with why.
    const buttons = [...html.matchAll(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Invite link<\/button>/g)].map(([b]) => b);
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toContain('aria-disabled="false"');
    expect(buttons.slice(1).every((b) => b.includes('aria-disabled="true"'))).toBe(true);
    // Someone not in admin hands none out: every row's is disabled, and says why.
    const bo = (await page("/people", "bo", inviter)).html;
    expect([
      ...bo.matchAll(/<button[^>]*aria-disabled="true"[^>]*>(?:(?!<\/button>)[\s\S])*Invite link<\/button>/g),
    ]).toHaveLength(3);
    expect(bo).toContain("Only someone in admin makes an invite link");
    // The open person's card has the same entry.
    expect((await page("/people?person=ada", "ada", inviter)).html).toMatch(
      /role="region"[^>]*aria-label="ada"(?:(?!<\/form>)[\s\S])*<button[^>]*>(?:(?!<\/button>)[\s\S])*Invite link<\/button>/,
    );
  });

  it("mints an invite link from a row into a card with Copy, in Chrome", async (ctx) => {
    const chrome = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
    if (!existsSync(chrome)) ctx.skip("no Chrome: install Google Chrome or set CHROME_PATH");
    const browser = await launch({ executablePath: chrome, headless: true });
    try {
      const origin = new URL(inviter.url).origin;
      await browser
        .defaultBrowserContext()
        .overridePermissions(origin, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
      const tab = await browser.newPage();
      await tab.setViewport({ width: 1440, height: 900 });
      await browser.setCookie({ name: ACTOR_COOKIE, value: "ada", domain: new URL(origin).hostname, path: "/" });
      await tab.goto(new URL("/people", origin).href, { waitUntil: "networkidle0" });
      await tab.click("tbody tr:first-child button");
      const card = '[role="region"][aria-label="Invite link for Ada Ortiz"]';
      await tab.waitForSelector(card);
      await tab.waitForFunction(`document.querySelector("#invite-url")?.value.includes("/auth/invite/")`);
      const link = `${origin}/auth/invite/tok-ada@example.test`;
      expect(await tab.evaluate(`document.querySelector("#invite-url").value`)).toBe(link);
      const said = (await tab.evaluate(`document.querySelector('${card}').textContent`)) as string;
      expect(said).toContain("Works once, 24 hours.");
      expect(said).toContain("Send it any way you like: text, Slack, email.");
      expect(said).toContain("Opening it signs Ada in as ada@example.test. A new link replaces this one.");
      // The row it is for is marked.
      expect(await tab.evaluate(`document.querySelector("tbody tr:first-child").dataset.state`)).toBe("selected");
      // Copy puts the link on the clipboard, and says so.
      await tab.click(`${card} button::-p-text(Copy)`);
      await tab.waitForSelector("[data-sonner-toast]::-p-text(Copied Ada)");
      expect(await tab.evaluate(`navigator.clipboard.readText()`)).toBe(link);
      // Closing it leaves the list.
      await tab.click(`${card} button::-p-text(Close)`);
      await tab.waitForFunction(`!document.querySelector('${card}')`);
    } finally {
      await browser.close();
    }
  }, 60_000);

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
