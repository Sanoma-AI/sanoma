// The shell, started from its build, opens a fixture company: its `pnpm install` (the staged pnpm)
// links the fake launcher, which runs on the Node the shell ships; the company's window shows the
// app; closing it stops the launcher. Needs `pnpm run build` and `pnpm run stage:resources`.
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, expect, test } from "@playwright/test";
import { slugOf } from "../../src/companies.ts";

const pkg = fileURLToPath(new URL("../../", import.meta.url));
/** The Electron binary: the `electron` package's main export, in Node, is its path. */
const executablePath = createRequire(import.meta.url)("electron") as string;
const { engines } = JSON.parse(
  readFileSync(new URL("../../../sanoma/template/package.json", import.meta.url), "utf8"),
) as { engines: { node: string } };

/** A version as [major, minor, patch]. */
const parse = (version: string) => [...version.split(".").map(Number), 0, 0].slice(0, 3);
/** Whether version `a` is `b` or after it. */
const atLeast = (a: number[], b: number[]) => {
  const i = a.findIndex((n, j) => n !== b[j]);
  return i === -1 || a[i]! > b[i]!;
};

/** Whether `version` satisfies `range`, in the forms the template's engines use: `^X.Y` and `>=X`, joined by `||`. */
function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  return range.split("||").some((part) => {
    const [, op, floor] = /^\s*(\^|>=)(\d+(?:\.\d+){0,2})\s*$/.exec(part) ?? [];
    if (!op || !floor) throw new Error(`a range this test does not read: ${part}`);
    const f = parse(floor);
    return atLeast(v, f) && (op === ">=" || v[0] === f[0]);
  });
}

test("opens a company, shows its app on the shipped Node, and stops it with the window", async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-desktop-e2e-")));
  // Outside the workspace, so its `pnpm install` is the company's own.
  const company = join(work, "fixture");
  cpSync(fileURLToPath(new URL("../fixtures/company", import.meta.url)), company, { recursive: true });
  let shell: ElectronApplication | undefined;
  let logs: string | undefined;
  try {
    shell = await electron.launch({
      executablePath,
      args: [pkg, company, `--user-data-dir=${join(work, "user-data")}`],
    });
    logs = await shell.evaluate(({ app }) => app.getPath("logs"));
    /** The company's window, once it shows the app (the start window shows a file). */
    const companyWindow = () => shell!.windows().find((page) => page.url().startsWith("http://"));
    await expect.poll(() => companyWindow()?.url(), { timeout: 45_000 }).toBeDefined();
    const window = companyWindow()!;
    const started = JSON.parse(readFileSync(join(company, "started.json"), "utf8")) as {
      port: number;
      node: string;
      execPath: string;
    };
    // The ready event's URL (SANOMA_EVENTS=1), not the human line's.
    expect(window.url()).toBe(`http://127.0.0.1:${started.port}/`);
    expect(started.execPath).toBe(join(pkg, "stage", `node-${process.arch}`, "node"));
    await expect(window.locator("#node")).toHaveText(started.node);
    expect(satisfies(started.node, engines.node), `Node ${started.node} for ${engines.node}`).toBe(true);

    // As the person does: the company's window closes, and its launcher is stopped.
    await shell.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().startsWith("http://"))
        ?.close();
    });
    await expect.poll(() => existsSync(join(company, "stopped")), { timeout: 15_000 }).toBe(true);
  } finally {
    await shell?.close();
    rmSync(work, { recursive: true, force: true });
    // The shell's log of this start (on macOS, ~/Library/Logs/Sanoma, outside the user data dir).
    if (logs) rmSync(join(logs, `${slugOf(company)}.log`), { force: true });
  }
});
