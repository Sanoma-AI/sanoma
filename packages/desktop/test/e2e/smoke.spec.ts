// The shell opens a fixture company: its `pnpm install` links the fake launcher, which runs on the
// Node the shell ships; one window shows the start, then the app; closing it leaves the launcher
// running, opening the folder again shows it, Quit stops it, and the next launch opens it again.
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
const floor = Number(/^>=(\d+)$/.exec(engines.node)?.[1] ?? Number.NaN);

/** The company windows (`BaseWindow`s, not the start window): whether each shows, where, and its views' pages. */
const companyWindows = (shell: ElectronApplication) =>
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

type Shown = Awaited<ReturnType<typeof companyWindows>>[number];
/** The page a window shows: the shell's own (a file), or the app. */
const showing = (window: Shown | undefined) => window?.views.find((view) => view.visible)?.url;
const isApp = (url: string | undefined) => url?.startsWith("http://") ?? false;

test("opens a company in one window from progress to app, keeps it running when closed, and reopens it after Quit", async () => {
  // By real path, as the shell names a company's log after it (macOS's tmpdir is a symlink).
  const work = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-desktop-e2e-")));
  // Outside the workspace, so its `pnpm install` is the company's own.
  const company = join(work, "fixture");
  cpSync(fileURLToPath(new URL("../fixtures/company", import.meta.url)), company, { recursive: true });
  const userData = join(work, "user-data");
  const launchShell = (...args: string[]) =>
    electron.launch({ executablePath, args: [pkg, ...args, `--user-data-dir=${userData}`] });
  let shell: ElectronApplication | undefined;
  let log: string | undefined;
  try {
    shell = await launchShell(company);
    // On macOS the logs folder is outside the user data folder.
    log = join(await shell.evaluate(({ app }) => app.getPath("logs")), `${slugOf(company)}.log`);
    // The company's window shows its start: the install and the launcher on their way…
    await expect
      .poll(async () => showing((await companyWindows(shell!))[0]), { timeout: 30_000, intervals: [50] })
      .toMatch(/company\.html$/);
    const [progress] = await companyWindows(shell);
    writeFileSync(join(company, "go"), "");
    // …then the app, in that same window: none other was made, none hidden.
    await expect
      .poll(async () => isApp(showing((await companyWindows(shell!))[0])), { timeout: 45_000, intervals: [100] })
      .toBe(true);
    const windows = await companyWindows(shell);
    expect(windows.map((w) => [w.id, w.visible])).toEqual([[progress!.id, true]]);
    expect(windows[0]!.views.map((view) => isApp(view.url))).toEqual([true, false]);
    expect(existsSync(join(userData, "companies.json")), "the shell keeps its state in --user-data-dir").toBe(true);
    const started = JSON.parse(readFileSync(join(company, "started.json"), "utf8")) as {
      port: number;
      execPath: string;
      pid: number;
    };
    // The ready event's URL (SANOMA_EVENTS=1), not the human line's.
    expect(showing(windows[0])).toBe(`http://127.0.0.1:${started.port}/`);
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
    await expect.poll(async () => (await companyWindows(shell!))[0]?.visible).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(existsSync(join(company, "stopped")), "closing the window leaves the company running").toBe(false);
    expect(() => process.kill(started.pid, 0)).not.toThrow();

    // Opening its folder again shows that window, on the app, without starting it again.
    await shell.evaluate(({ app }, dir) => app.emit("open-file", { preventDefault() {} }, dir), company);
    await expect.poll(async () => (await companyWindows(shell!))[0]?.visible).toBe(true);
    const again = await companyWindows(shell);
    expect(again.map((w) => w.id)).toEqual([progress!.id]);
    expect(isApp(showing(again[0]))).toBe(true);
    expect(JSON.parse(readFileSync(join(company, "started.json"), "utf8")).pid).toBe(started.pid);

    // Quit stops it, and keeps where its window was and that it was open.
    const bounds = { x: 120, y: 90, width: 900, height: 700 };
    await shell.evaluate(({ BaseWindow }, [id, to]) => BaseWindow.fromId(id)!.setBounds(to), [
      progress!.id,
      bounds,
    ] as const);
    const first = shell.process();
    await shell.close();
    shell = undefined;
    // Its single-instance lock goes with the process: the next launch must not hand its folder to this one.
    if (first.exitCode === null && first.signalCode === null) await once(first, "exit");
    expect(existsSync(join(company, "stopped")), "Quit stops the company").toBe(true);

    // The next launch, with no folder named, opens it again at those bounds.
    shell = await launchShell();
    await expect
      .poll(async () => isApp(showing((await companyWindows(shell!))[0])), { timeout: 45_000, intervals: [100] })
      .toBe(true);
    expect((await companyWindows(shell))[0]!.bounds).toEqual(bounds);
    // Its windows only: the app's own folder on the command line is no company to complain about.
    expect(await shell.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  } catch (err) {
    if (log && existsSync(log)) console.error(`the shell's log:\n${readFileSync(log, "utf8")}`);
    throw err;
  } finally {
    await shell?.close().catch(() => {});
    rmSync(work, { recursive: true, force: true });
    if (log) rmSync(log, { force: true });
  }
});
