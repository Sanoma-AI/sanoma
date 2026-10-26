// The shell opens a fixture company: its `pnpm install` links the fake launcher, which runs on the
// Node the shell ships; the company's window shows the app; closing it stops the launcher.
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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

/** A version as [major, minor, patch]. */
const parse = (version: string) => [...version.split(".").map(Number), 0, 0].slice(0, 3);
/** Below zero when version `a` is before `b`. */
const compare = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;

/** Whether `version` satisfies `range`, in the forms the template's engines use: `^X.Y` and `>=X`, joined by `||`. */
function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  return range.split("||").some((part) => {
    const [, op, floor] = /^\s*(\^|>=)(\d+(?:\.\d+){0,2})\s*$/.exec(part) ?? [];
    if (!op || !floor) throw new Error(`a range this test does not read: ${part}`);
    const f = parse(floor);
    return compare(v, f) >= 0 && (op === ">=" || v[0] === f[0]);
  });
}

test("opens a company, shows its app on the shipped Node, and stops it with the window", async () => {
  // By real path, as the shell names a company's log after it (macOS's tmpdir is a symlink).
  const work = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-desktop-e2e-")));
  // Outside the workspace, so its `pnpm install` is the company's own.
  const company = join(work, "fixture");
  cpSync(fileURLToPath(new URL("../fixtures/company", import.meta.url)), company, { recursive: true });
  const userData = join(work, "user-data");
  let shell: ElectronApplication | undefined;
  let log: string | undefined;
  try {
    shell = await electron.launch({ executablePath, args: [pkg, company, `--user-data-dir=${userData}`] });
    // On macOS the logs folder is outside the user data folder.
    log = join(await shell.evaluate(({ app }) => app.getPath("logs")), `${slugOf(company)}.log`);
    /** The company's window, once it shows the app (the start window shows a file). */
    const companyWindow = () => shell!.windows().find((page) => page.url().startsWith("http://"));
    await expect.poll(() => companyWindow()?.url(), { timeout: 45_000, intervals: [100] }).toBeDefined();
    const window = companyWindow()!;
    expect(existsSync(join(userData, "companies.json")), "the shell keeps its state in --user-data-dir").toBe(true);
    const started = JSON.parse(readFileSync(join(company, "started.json"), "utf8")) as {
      port: number;
      execPath: string;
    };
    // The ready event's URL (SANOMA_EVENTS=1), not the human line's.
    expect(window.url()).toBe(`http://127.0.0.1:${started.port}/`);
    expect(started.execPath).toBe(runtimeOf({ packaged: false, appPath: pkg, resourcesPath: "" }).node);
    const node = (await window.locator("#node").textContent()) ?? "";
    expect(satisfies(node, engines.node), `Node ${node} for ${engines.node}`).toBe(true);

    // As the person does: the company's window closes, and its launcher is stopped.
    await window.close();
    await expect.poll(() => existsSync(join(company, "stopped")), { timeout: 15_000, intervals: [100] }).toBe(true);
    // And the shell goes on, with its start window.
    expect(await shell.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThan(0);
  } catch (err) {
    if (log && existsSync(log)) console.error(`the shell's log:\n${readFileSync(log, "utf8")}`);
    throw err;
  } finally {
    await shell?.close().catch(() => {});
    rmSync(work, { recursive: true, force: true });
    if (log) rmSync(log, { force: true });
  }
});
