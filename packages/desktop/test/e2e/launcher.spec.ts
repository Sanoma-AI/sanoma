// What a person sees on the way to the app: a start's page and its details, Stop, a failure, and a
// synced folder's warning, which the app waits for. Each in a shell of its own, its home folder a
// temporary one, as that is where iCloud's folder is looked for.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { slugOf } from "../../src/companies.ts";

const pkg = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const executablePath = createRequire(import.meta.url)("electron") as string;

let work: string;
let shell: ElectronApplication;
const logs: string[] = [];

const launch = async (...args: string[]) => {
  shell = await electron.launch({
    executablePath,
    args: [pkg, ...args, `--user-data-dir=${join(work, "user-data")}`],
    env: { ...process.env, HOME: join(work, "home") } as Record<string, string>,
  });
  const logsFolder = await shell.evaluate(({ app }) => app.getPath("logs"));
  logs.push(...args.map((dir) => join(logsFolder, `${slugOf(dir)}.log`)));
};

const fixture = (dir: string) => {
  cpSync(fileURLToPath(new URL("../fixtures/company", import.meta.url)), dir, { recursive: true });
  return dir;
};

/** The shell's page whose file name is `file`, once it is there. */
async function pageNamed(file: string): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      () =>
        (found = shell
          .context()
          .pages()
          .find((page) => page.url().endsWith(file))),
      { timeout: 30_000 },
    )
    .toBeTruthy();
  return found!;
}

const shown = () =>
  shell.evaluate(({ BaseWindow }) =>
    BaseWindow.getAllWindows()[0]!
      .contentView.children.filter((view) => view.getVisible())
      .map((view) => (view as Electron.WebContentsView).webContents.getURL())
      .join(),
  );
const terminal = (page: Page) => page.locator("#log .xterm-rows");
const settingsFile = () => join(work, "user-data", "settings.json");
const settings = () => (existsSync(settingsFile()) ? (JSON.parse(readFileSync(settingsFile(), "utf8")) as object) : {});

test.beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-desktop-launcher-")));
  mkdirSync(join(work, "home"));
});

test.afterEach(async () => {
  await shell?.close().catch(() => {});
  rmSync(work, { recursive: true, force: true });
  for (const log of logs.splice(0)) rmSync(log, { force: true });
});

test("a start: its steps; details a click away and remembered; Stop", async () => {
  const company = fixture(join(work, "acme"));
  await launch(company);
  const page = await pageNamed("company.html");
  await expect(page.locator("#steps li")).toHaveText(["Installing what it needs", "Starting the company"], {
    timeout: 10_000,
  });
  await expect(page.locator("#output")).toBeHidden();

  await page.click("#details");
  await expect(terminal(page)).toContainText("fixture waiting", { timeout: 45_000 });
  await expect(page.locator("#details-label")).toHaveText("Hide details");
  expect(settings()).toMatchObject({ details: true });

  await page.click("#stop");
  await expect.poll(() => existsSync(join(company, "stopped")), { timeout: 15_000 }).toBe(true);
  await expect.poll(shown).toMatch(/index\.html$/);
});

test("a failure leads with why, its output open under it, and that does not repeat there", async () => {
  const company = fixture(join(work, "acme"));
  writeFileSync(
    join(company, "fake-sanoma", "bin.mjs"),
    `#!/usr/bin/env node
console.log("what it printed");
console.log(JSON.stringify({ sanoma: 1, event: "error", message: "no workflows" }));
process.exit(2);
`,
  );
  await launch(company);
  const page = await pageNamed("company.html");
  const reason = "The company's configuration has a problem (no workflows). Fix it, then start again.";
  await expect(page.locator("#reason")).toHaveText(reason, { timeout: 45_000 });
  await expect(page.locator("#pill")).toHaveText("Did not start");
  await expect(terminal(page)).toContainText("what it printed");
  await expect(terminal(page)).not.toContainText("configuration has a problem");
  expect(readFileSync(logs[0]!, "utf8")).toContain(reason);

  await page.click("#copy");
  await expect.poll(() => shell.evaluate(({ clipboard }) => clipboard.readText())).toContain(reason);
  expect(await shell.evaluate(({ clipboard }) => clipboard.readText())).toContain("what it printed");

  await page.click("#hide");
  await expect(page.locator("#output")).toBeHidden();
  await page.click("#details");
  await expect(page.locator("#output")).toBeVisible();
  // Hiding it on a failed page says nothing of later starts.
  expect(settings()).not.toMatchObject({ details: true });
});

test("the app waits for Got it on a synced folder, once per folder", async () => {
  const synced = join(work, "home", "Library", "Mobile Documents", "acme");
  mkdirSync(join(synced, ".."), { recursive: true });
  fixture(synced);
  writeFileSync(join(synced, "go"), "");
  await launch(synced);
  const page = await pageNamed("company.html");
  await expect(page.locator("#warning")).toContainText("This folder is in iCloud");
  // Ready, and still on its page, every step done.
  await expect(page.locator("#steps li.done")).toHaveCount(2, { timeout: 45_000 });
  await page.waitForTimeout(1_000);
  expect(await shown()).toMatch(/company\.html$/);

  await page.click("#got-it");
  await expect.poll(shown).toMatch(/^http:/);
  await shell.close();

  await launch(synced);
  await expect.poll(shown, { timeout: 45_000 }).toMatch(/^http:/);
});

test("a new company's form asks its name and says where it goes, making nothing until it is answered", async () => {
  mkdirSync(join(work, "elsewhere"));
  await launch();
  const page = await pageNamed("index.html");
  await page.click("#create");
  await page.fill("#new-name", "Northside Plumbing");
  await expect(page.locator("#new-place")).toHaveText(join("~", "Companies", "northside-plumbing"));
  await page.fill("#new-name", "...");
  await page.click('#new-form button[type="submit"]');
  await expect(page.locator("#new-problem")).toContainText("Give the company a name");
  await expect(page.locator("#new-name")).toHaveValue("...");

  // Another place: what is typed stays, and the problem, about the last try, goes.
  const elsewhere = realpathSync(join(work, "elsewhere"));
  const answering = (dir: string) =>
    shell.evaluate(({ dialog }, answer) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [answer] })) as typeof dialog.showOpenDialog;
    }, dir);
  await answering(elsewhere);
  await page.click("#new-change");
  await expect(page.locator("#new-place")).toContainText(join("elsewhere", "…"));
  await expect(page.locator("#new-name")).toHaveValue("...");
  await expect(page.locator("#new-problem")).toBeHidden();

  // A refusal from the menu shows over the form it leaves open.
  await shell.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      ?.items.flatMap((item) => item.submenu?.items ?? [])
      .find((item) => item.label === "Open Company…")
      ?.click(),
  );
  await expect(page.locator("#notice")).toContainText("elsewhere");
  await expect(page.locator("#new-form")).toBeVisible();

  await page.click("#new-form [data-cancel]");
  await expect(page.locator("#home")).toBeVisible();
  expect(existsSync(join(work, "home", "Companies"))).toBe(false);
});
