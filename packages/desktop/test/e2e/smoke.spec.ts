// The shell opens a fixture company: its `pnpm install` links the fake launcher, which runs on the
// Node the shell ships; the one window shows the start, then the app, and nothing else; closing it
// leaves the launcher running, and opening the folder again shows it. A second company joins the
// same window, the first kept running and loaded; ⌘1 and the apps' companies API (the account
// menu's) switch, Company → Stop stops the shown one and shows the other, Quit stops that, and the
// next launch opens it again.
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, expect, test } from "@playwright/test";
import { slugOf } from "../../src/companies.ts";
import { runtimeOf } from "../../src/runtime.ts";

const pkg = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
/** The Electron binary: the `electron` package's main export, in Node, is its path. */
const executablePath = createRequire(import.meta.url)("electron") as string;
const { engines } = JSON.parse(
  readFileSync(new URL("../../../sanoma/template/package.json", import.meta.url), "utf8"),
) as { engines: { node: string } };

/** The lowest Node major the template's engines (`>=X`) allow. */
const floor = Number(
  /^>=(\d+)$/.exec(engines.node)?.[1] ??
    (() => {
      throw new Error(`an engines range this test does not read: ${engines.node}`);
    })(),
);

/** The shell's windows (`BaseWindow`s, the app's own windows aside): whether each shows, where, and its views' pages. */
const shellWindows = (shell: ElectronApplication) =>
  shell.evaluate(({ BaseWindow, BrowserWindow }) =>
    BaseWindow.getAllWindows()
      .filter((window) => !(window instanceof BrowserWindow))
      .map((window) => ({
        id: window.id,
        visible: window.isVisible(),
        bounds: window.getNormalBounds(),
        views: window.contentView.children.map((view) => ({
          url: (view as Electron.WebContentsView).webContents.getURL(),
          visible: view.getVisible(),
        })),
      })),
  );

type Shown = Awaited<ReturnType<typeof shellWindows>>[number];
/** The page a window shows: the shell's own (a file), or an app. */
const showing = (window: Shown | undefined) => window?.views.find((view) => view.visible)?.url;
const isApp = (url: string | undefined) => url?.startsWith("http://") ?? false;
/** The app URLs the window holds, shown or not. */
const apps = (window: Shown | undefined) => window?.views.map((view) => view.url).filter(isApp);

const startedOf = (company: string) =>
  JSON.parse(readFileSync(join(company, "started.json"), "utf8")) as { port: number; execPath: string; pid: number };

/** A company as its app's account menu gets it (`window.sanomaDesktop`, the app view's preload). */
type DesktopCompany = { id: string; name: string; shown: boolean };

test("one window: a company from progress to app, a second beside it, switching, Stop, Quit and the next launch", async () => {
  // By real path, as the shell names a company's log after it (macOS's tmpdir is a symlink).
  const work = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-desktop-e2e-")));
  // Outside the workspace, so their `pnpm install` is the company's own.
  const company = join(work, "fixture");
  const second = join(work, "second");
  for (const dir of [company, second]) {
    cpSync(fileURLToPath(new URL("../fixtures/company", import.meta.url)), dir, { recursive: true });
  }
  const userData = join(work, "user-data");
  const launchShell = (...args: string[]) =>
    electron.launch({ executablePath, args: [pkg, ...args, `--user-data-dir=${userData}`] });
  let shell: ElectronApplication | undefined;
  const logs: string[] = [];
  const windowsNow = () => shellWindows(shell!);
  const shownNow = async () => showing((await windowsNow())[0]);
  /** Runs `code` in the page at `url`: an app's, with the shell's companies API. */
  const inApp = <T>(url: string, code: string) =>
    shell!.evaluate(
      ({ webContents }, [page, js]) =>
        webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === page)!
          .executeJavaScript(js) as Promise<T>,
      [url, code] as const,
    );
  const companiesIn = (url: string) => inApp<DesktopCompany[]>(url, "window.sanomaDesktop.companies()");
  try {
    shell = await launchShell(company);
    // On macOS the logs folder is outside the user data folder.
    const logsFolder = await shell.evaluate(({ app }) => app.getPath("logs"));
    logs.push(...[company, second].map((dir) => join(logsFolder, `${slugOf(dir)}.log`)));
    // The window shows the company's start: the install and the launcher on their way…
    await expect.poll(shownNow, { timeout: 30_000, intervals: [50] }).toMatch(/company\.html$/);
    const [progress] = await windowsNow();
    writeFileSync(join(company, "go"), "");
    // …then the app, in that same window, alone: none other was made, and nothing beside it.
    await expect.poll(async () => isApp(await shownNow()), { timeout: 45_000, intervals: [100] }).toBe(true);
    const windows = await windowsNow();
    expect(windows.map((w) => [w.id, w.visible])).toEqual([[progress!.id, true]]);
    expect(windows[0]!.views.filter((view) => view.visible)).toHaveLength(1);
    expect(existsSync(join(userData, "companies.json")), "the shell keeps its state in --user-data-dir").toBe(true);
    const started = startedOf(company);
    // The ready event's URL (SANOMA_EVENTS=1), not the human line's.
    const first = `http://127.0.0.1:${started.port}/`;
    expect(showing(windows[0])).toBe(first);
    // The app's account menu lists it, shown, by an id that is no path.
    const [one] = await companiesIn(first);
    expect(await companiesIn(first)).toEqual([{ id: expect.any(String), name: "fixture-company", shown: true }]);
    expect(one!.id).not.toContain(work);
    expect(started.execPath).toBe(runtimeOf({ packaged: false, appPath: pkg, resourcesPath: "" }).node);
    const node = await shell.evaluate(
      ({ webContents }) =>
        webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().startsWith("http://"))!
          .executeJavaScript("document.getElementById('node').textContent") as Promise<string>,
    );
    expect(Number(node.split(".")[0]), `Node ${node} for ${engines.node}`).toBeGreaterThanOrEqual(floor);

    // As the person does: the window closes, and the company goes on running.
    await shell.evaluate(({ BaseWindow }, id) => BaseWindow.fromId(id)!.close(), progress!.id);
    await expect.poll(async () => (await windowsNow())[0]?.visible).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(existsSync(join(company, "stopped")), "closing the window leaves the company running").toBe(false);
    expect(() => process.kill(started.pid, 0)).not.toThrow();

    // Opening its folder again shows the window, on the app, without starting it again.
    const open = (dir: string) =>
      shell!.evaluate(({ app }, folder) => app.emit("open-file", { preventDefault() {} }, folder), dir);
    await open(company);
    await expect.poll(async () => (await windowsNow())[0]?.visible).toBe(true);
    expect((await windowsNow()).map((w) => w.id)).toEqual([progress!.id]);
    expect(await shownNow()).toBe(first);
    expect(startedOf(company).pid).toBe(started.pid);

    // A second company joins the same window, shown; the first runs on, its app loaded.
    writeFileSync(join(second, "go"), "");
    await open(second);
    await expect
      .poll(async () => isApp(await shownNow()) && (await shownNow()) !== first, { timeout: 45_000, intervals: [100] })
      .toBe(true);
    const both = await windowsNow();
    expect(both.map((w) => w.id)).toEqual([progress!.id]);
    const secondUrl = `http://127.0.0.1:${startedOf(second).port}/`;
    expect(showing(both[0])).toBe(secondUrl);
    expect(apps(both[0])).toEqual([first, secondUrl]);
    expect(startedOf(company).pid).toBe(started.pid);
    const listed = await companiesIn(secondUrl);
    expect(listed.map((c) => [c.id, c.shown])).toEqual([
      [one!.id, false],
      [expect.any(String), true],
    ]);
    const two = listed[1]!;

    // ⌘1 (the Window menu's first company) switches back, at once: nothing reloads or starts.
    const click = (id: string) =>
      shell!.evaluate(({ Menu }, item) => Menu.getApplicationMenu()!.getMenuItemById(item)!.click(), id);
    await click("company-1");
    expect(await shownNow()).toBe(first);
    expect(startedOf(company).pid).toBe(started.pid);

    // The account menu's switch, from either app, and its subscription: the other app hears of it.
    await inApp(secondUrl, "window.sanomaDesktop.onCompanies((c) => (window.heard = c)), true");
    await inApp(first, `window.sanomaDesktop.switch(${JSON.stringify(two.id)})`);
    expect(await shownNow()).toBe(secondUrl);
    await expect
      .poll(() => inApp<DesktopCompany[]>(secondUrl, "window.heard"))
      .toEqual([
        { ...one, shown: false },
        { ...two, shown: true },
      ]);
    // An id it does not know switches nothing; then back to the first.
    await inApp(secondUrl, `window.sanomaDesktop.switch("nope")`);
    expect(await shownNow()).toBe(secondUrl);
    await inApp(secondUrl, `window.sanomaDesktop.switch(${JSON.stringify(one!.id)})`);
    expect(await shownNow()).toBe(first);

    // Company → Stop stops the shown company and takes it out: the other shows, alone again.
    await click("stop");
    await expect.poll(() => existsSync(join(company, "stopped")), { timeout: 15_000 }).toBe(true);
    const after = await windowsNow();
    expect(showing(after[0])).toBe(secondUrl);
    expect(apps(after[0])).toEqual([secondUrl]);
    expect(await companiesIn(secondUrl)).toEqual([{ ...two, shown: true }]);

    // Quit stops it, and keeps where the window was and that the company was open.
    const bounds = { x: 120, y: 90, width: 900, height: 700 };
    await shell.evaluate(({ BaseWindow }, [id, to]) => BaseWindow.fromId(id)!.setBounds(to), [
      progress!.id,
      bounds,
    ] as const);
    const quitting = shell.process();
    await shell.close();
    shell = undefined;
    // Its single-instance lock goes with the process: the next launch must not hand its folder to this one.
    if (quitting.exitCode === null && quitting.signalCode === null) await once(quitting, "exit");
    expect(existsSync(join(second, "stopped")), "Quit stops the company").toBe(true);

    // The next launch, with no folder named, opens the open one again (not the stopped one) at those bounds.
    shell = await launchShell();
    await expect.poll(async () => isApp(await shownNow()), { timeout: 45_000, intervals: [100] }).toBe(true);
    const relaunched = await windowsNow();
    expect(relaunched).toHaveLength(1);
    expect(relaunched[0]!.bounds).toEqual(bounds);
    expect(apps(relaunched[0])).toEqual([`http://127.0.0.1:${startedOf(second).port}/`]);
    // Its window only: the app's own folder on the command line is no company to complain about.
    expect(await shell.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  } catch (err) {
    for (const log of logs) {
      if (existsSync(log)) console.error(`the shell's log (${log}):\n${readFileSync(log, "utf8")}`);
    }
    throw err;
  } finally {
    await shell?.close().catch(() => {});
    rmSync(work, { recursive: true, force: true });
    for (const log of logs) rmSync(log, { force: true });
  }
});
