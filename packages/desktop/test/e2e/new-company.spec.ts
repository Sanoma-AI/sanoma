// New Company, for real, in the packaged app: `pnpm dlx sanoma` from the registry in the environment
// (the sanoma of this commit, from desktop.yml's local one), the template, the first commit, the
// install, the company's own Postgres and the app in the window. Then Quit stops it all, and a next
// launch, killed outright as in a crash, stops it all too. Only where SANOMA_DESKTOP_EXE names a
// packaged app; the smoke test covers the rest with a fake launcher.
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type ElectronApplication, expect, test } from "@playwright/test";
import { slugOf } from "../../src/companies.ts";

const executablePath = process.env.SANOMA_DESKTOP_EXE;
test.skip(!executablePath, "needs a packaged app (SANOMA_DESKTOP_EXE) and a registry with this commit's sanoma");
// An install from nothing, and PostgreSQL's first initdb, on a CI runner.
test.setTimeout(20 * 60_000);

/** Runs `code` in the shell's page or app at the URL `matching` finds, when there is one. */
const inPage = <T>(shell: ElectronApplication, matching: string, code: string) =>
  shell.evaluate(
    ({ webContents }, [pattern, js]) =>
      webContents
        .getAllWebContents()
        .find((contents) => new RegExp(pattern!).test(contents.getURL()))
        ?.executeJavaScript(js) as Promise<T> | undefined,
    [matching, code] as const,
  );

/** The app's URL, once the window holds it. */
const appUrl = (shell: ElectronApplication) =>
  shell.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .map((contents) => contents.getURL())
      .find((url) => url.startsWith("http://")),
  );

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("New Company, from an empty folder to the app, then Quit, then a crash", async () => {
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), "sanoma-desktop-new-")));
  const folder = join(work, "acme");
  mkdirSync(folder);
  const postmasterPid = join(folder, ".sanoma", "postgres", "data", "postmaster.pid");
  const postgresPid = () => Number(readFileSync(postmasterPid, "utf8").split("\n")[0]);
  // A git with no identity, as a new computer's, so the form asks; the setting goes to this file.
  const gitConfig = join(work, "gitconfig");
  writeFileSync(gitConfig, "");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitConfig,
    // This commit's packages were published to the registry a moment ago: `pnpm dlx` holds them back otherwise.
    pnpm_config_minimum_release_age: "0",
  } as Record<string, string>;
  const launchShell = () =>
    electron.launch({ executablePath: executablePath!, args: [`--user-data-dir=${join(work, "user-data")}`], env });
  const gitIn = (...args: string[]) => execFileSync("git", ["-C", folder, ...args], { encoding: "utf8", env }).trim();

  let shell: ElectronApplication | undefined = await launchShell();
  const log = join(await shell.evaluate(({ app }) => app.getPath("logs")), `${slugOf(folder)}.log`);
  try {
    // The folder dialog is the operating system's; the person's answer is the empty folder.
    await shell.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
    }, folder);
    await expect
      .poll(() => inPage(shell!, "start", `Boolean(document.getElementById("create"))`), { timeout: 30_000 })
      .toBe(true);
    await inPage(shell, "start", `document.getElementById("create").click(), true`);
    await expect
      .poll(() => inPage(shell!, "start", `document.getElementById("identity-form").hidden`), { timeout: 30_000 })
      .toBe(false);
    await inPage(
      shell,
      "start",
      `document.getElementById("identity-name").value = "Ada Lovelace";
       document.getElementById("identity-email").value = "ada@example.com";
       document.getElementById("identity-form").requestSubmit(); true`,
    );

    await expect
      .poll(
        () => {
          // What the launcher reported as its failure ends the wait, with the log below.
          if (existsSync(log) && readFileSync(log, "utf8").includes(`"event":"error"`)) throw new Error("it failed");
          return appUrl(shell!);
        },
        { timeout: 15 * 60_000, intervals: [1_000] },
      )
      .toMatch(/^http:\/\/127/);
    const url = (await appUrl(shell))!;

    // The launcher's init did its part: the commit, under the name given; the install; the Postgres.
    expect(gitIn("log", "-1", "--format=%s|%an|%ae")).toBe("Start a Sanoma company|Ada Lovelace|ada@example.com");
    expect(existsSync(join(folder, "node_modules", "sanoma", "package.json"))).toBe(true);
    const first = postgresPid();
    expect(alive(first)).toBe(true);
    // The app answers, and its page is the app's, not an error.
    expect((await fetch(new URL("/healthz", url))).ok, url).toBe(true);
    await expect
      .poll(() => inPage<string>(shell!, "^http://", "document.body.innerText.length"), { timeout: 60_000 })
      .toBeGreaterThan(0);

    // Quit stops the company: the app, the worker and Postgres, and nothing is left holding the folder.
    const quitting = shell.process();
    await shell.close();
    shell = undefined;
    if (quitting.exitCode === null && quitting.signalCode === null) await once(quitting, "exit");
    await expect.poll(() => alive(first), { timeout: 30_000 }).toBe(false);
    expect(existsSync(postmasterPid), "Postgres shut down cleanly").toBe(false);
    await expect(fetch(url)).rejects.toThrow();

    // The next launch opens it again, its own Postgres back up.
    shell = await launchShell();
    await expect.poll(() => appUrl(shell!), { timeout: 5 * 60_000, intervals: [500] }).toMatch(/^http:\/\/127/);
    const again = (await appUrl(shell))!;
    const second = postgresPid();
    expect(alive(second)).toBe(true);

    // The shell killed outright, as in a crash: the launcher sees its stdin end and stops all it runs.
    // By the pid it says it has: on Windows, Playwright's `process()` is the `cmd` that started it.
    const crashing = await shell.evaluate(() => process.pid);
    process.kill(crashing, "SIGKILL");
    await expect.poll(() => alive(crashing), { timeout: 30_000 }).toBe(false);
    shell = undefined;
    await expect.poll(() => alive(second), { timeout: 60_000, intervals: [500] }).toBe(false);
    await expect
      .poll(
        () =>
          fetch(again).then(
            () => "answers",
            () => "stopped",
          ),
        { timeout: 60_000, intervals: [500] },
      )
      .toBe("stopped");
  } catch (err) {
    if (existsSync(log)) console.error(`the shell's log (${log}):\n${readFileSync(log, "utf8")}`);
    throw err;
  } finally {
    await shell?.close().catch(() => {});
    // Best effort: on Windows a new company's folder can resist it, and the temporary folder is the runner's.
    try {
      rmSync(log, { force: true });
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (err) {
      console.error(`left ${work}: ${String(err)}`);
    }
  }
});
