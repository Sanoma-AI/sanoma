import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "puppeteer-core";
import { REQUEST } from "./intro-fixture.ts";

interface Hooks {
  say(line: string): void;
  diff(id: string): string;
  restart(): Promise<string>;
  waiting(): Promise<void>;
  finished(): Promise<void>;
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function clickText(page: Page, selector: string, text: string) {
  const element = await page.waitForSelector(`${selector}::-p-text(${JSON.stringify(text)})`, { timeout: 120_000 });
  if (!element) throw new Error(`No ${text}`);
  await element.click();
}
async function textIs(page: Page, text: string, timeout = 120_000) {
  await page.waitForFunction((value) => document.body.innerText.includes(value), { timeout }, text);
}

/** Real app footage plus a clearly labelled view of the actual Git diff. No rewritten UI results. */
export async function captureIntro(browser: Browser, initialBase: string, dir: string, hooks: Hooks) {
  mkdirSync(dir, { recursive: true });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.evaluateOnNewDocument(() => {
    if (!localStorage.getItem("sanoma.actor")) localStorage.setItem("sanoma.actor", "dana");
  });
  let base = initialBase;
  const frames: { file: string; duration: number }[] = [];
  async function shot(caption: string, duration: number, detail = "") {
    // Reserve space for the caption without covering the real chat's composer/agent selector.
    await page.addStyleTag({
      content: "#chat { height: calc(100svh - 100px) !important; } body { padding-bottom: 110px; }",
    });
    await page.evaluate(
      (title, detailText) => {
        document.getElementById("recording-caption")?.remove();
        const bar = document.createElement("div");
        bar.id = "recording-caption";
        bar.style.cssText =
          "position:fixed;inset:auto 0 0;z-index:2147483647;background:#172420;color:#fff;padding:16px 28px 18px;font:600 24px/1.3 system-ui;pointer-events:none;box-shadow:0 -1px 0 #ffffff30";
        const main = document.createElement("div");
        main.textContent = title;
        bar.append(main);
        const note = document.createElement("div");
        note.style.cssText = "margin-top:7px;font:13px/1.4 system-ui;color:#c3d1ca";
        note.textContent = `Demo · scripted AI, simulated Git host & service calls${detailText ? ` · ${detailText}` : ""}`;
        bar.append(note);
        document.body.append(bar);
      },
      caption,
      detail,
    );
    await page.mouse.move(1190, 10);
    await pause(300);
    const file = `${String(frames.length).padStart(3, "0")}.png`;
    await page.screenshot({ path: join(dir, file) });
    frames.push({ file, duration });
  }
  async function navigate(path: string, actor = "dana", chat = false) {
    await context.setCookie({ name: "sanoma_chat", value: chat ? "open" : "closed", domain: new URL(base).hostname });
    if (new URL(page.url()).protocol === "http:")
      await page.evaluate((person) => localStorage.setItem("sanoma.actor", person), actor);
    await page.goto(base + path, { waitUntil: "networkidle0" });
    // On a restarted port, set the actor on this origin too.
    if (await page.evaluate((person) => localStorage.getItem("sanoma.actor") !== person, actor)) {
      await page.evaluate((person) => localStorage.setItem("sanoma.actor", person), actor);
      await page.reload({ waitUntil: "networkidle0" });
    }
  }
  try {
    hooks.say("recording the existing-plan selector and scripted request");
    await navigate("/workflows", "dana", true);
    await page.waitForSelector('select[aria-label="Engine"]');
    await page.select('select[aria-label="Engine"]', "acp-claude-code");
    await shot("Bring your existing Claude Code plan", 1.8, "Agent choice shown; no Claude session recorded");
    await page.select('select[aria-label="Engine"]', "loop");
    await page.type('textarea[aria-label="Message the agent"]', REQUEST, { delay: 2 });
    await shot("Ask for a page, workflow and approval rule", 2.2);
    await page.click('button[aria-label="Send"]');
    await textIs(page, "Review the actual check results", 240_000);
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("button")).some(
          (button) =>
            button.textContent?.trim() === "Send for review" && button.getAttribute("aria-disabled") === "false",
        ),
      { timeout: 240_000 },
    );
    hooks.say("the actual draft and checks are ready");
    await shot("A checked draft in your team's Git repo", 2, "Time condensed");
    await clickText(page, "button", "Send for review");
    await page.waitForFunction(() => location.pathname.startsWith("/changes/"), { timeout: 120_000 });
    const id = new URL(page.url()).pathname.split("/").at(-1)!;
    await navigate(`/changes/${id}`, "engineer");
    await textIs(page, "Publish waits for admin", 240_000);
    await textIs(page, "pass");
    // Changes lists changed files, not an inline source editor. Present the actual Git diff as
    // a separate shot, explicitly labelled, rather than inventing a product interface.
    const diff = hooks.diff(id);
    if (!diff.includes("resend.emails.send") || !diff.includes('@hold("marketing-lead")'))
      throw new Error("Draft lacks workflow/permission change");
    const diffPage = await context.newPage();
    await diffPage.setViewport({ width: 1200, height: 900 });
    await diffPage.setContent(
      '<html><body style="margin:0;background:#f7f8f6;color:#172420;font:18px system-ui"><header style="padding:24px 34px;border-bottom:1px solid #d9dfda"><b>Review the draft · added lines from Git diff</b><div style="font-size:14px;margin-top:8px">workflows/announce.ts + policies/marketing.cedar</div></header><pre style="margin:0;padding:20px 34px;font:16px/1.2 ui-monospace,monospace;white-space:pre-wrap"></pre><footer style="position:fixed;bottom:0;background:#172420;color:white;width:100%;padding:18px 34px;font:600 24px system-ui">Code and permission rules stay in Git<div style="font:13px system-ui;margin-top:7px">Demo · scripted AI, simulated Git host & service calls</div></footer></body></html>',
    );
    // Show the permission rule and the workflow's approval and effects, verbatim from Git.
    const excerpt = diff
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1))
      .filter((line) => line.trim())
      .join("\n");
    await diffPage.$eval(
      "pre",
      (el, value) => {
        el.textContent = value;
      },
      excerpt,
    );
    const diffFile = `${String(frames.length).padStart(3, "0")}.png`;
    await diffPage.screenshot({ path: join(dir, diffFile) });
    frames.push({ file: diffFile, duration: 2.8 });
    await diffPage.close();
    await shot("Review permissions. Approve the code change.", 2.8);
    await clickText(page, "button", "Publish");
    await page.waitForSelector('[role="dialog"]');
    await clickText(page, '[role="dialog"] button', "Publish");
    await textIs(page, "Published", 120_000);
    hooks.say("code change published through the real Git/approval flow; restarting on merged code");
    base = await hooks.restart();
    await navigate("/sites/launches", "dana");
    await page.waitForSelector("#field-title");
    await shot("A launch desk for your marketing team", 2.2);
    const opening = frames.pop()!;
    frames.unshift(opening);
    await page.type("#field-title", "Our November workshop");
    await page.type(
      "#field-body",
      "Join Paperplane Studio for our November workshop. New ideas, practical examples and time for your questions.",
    );
    await shot("Your coworker submits an announcement", 1.4);
    await clickText(page, "button", "Start run");
    await page.waitForSelector('a[href*="/runs/"]');
    const runPath = await page.$eval('a[href*="/runs/"]', (el) => el.getAttribute("href")!);
    await navigate(runPath);
    await page.waitForFunction(() => document.getElementById("run-status")?.textContent === "waiting");
    await hooks.waiting();
    await shot("Publishing and email wait for approval", 2);
    await navigate("/inbox", "marketing-lead");
    await textIs(page, "Approve this announcement");
    await shot("The marketing lead approves this announcement", 2.4);
    await clickText(page, "button", "Approve");
    await page.waitForSelector('[role="dialog"]');
    await page.type('[role="dialog"] textarea', "Copy approved for the November workshop.");
    await clickText(page, '[role="dialog"] button', "Approve");
    await navigate(runPath, "marketing-lead");
    await page.waitForFunction(() => document.getElementById("run-status")?.textContent === "finished", {
      timeout: 60_000,
    });
    await page.click('[aria-label="Inspector"] button[aria-label="Close"]');
    await page.click('[aria-label="Fit the graph"]');
    await pause(600);
    await shot("Ghost publishes. Resend sends the email.", 2.2);
    await clickText(page, '[role="tab"]', "Ledger");
    await page.evaluate(() => document.querySelector('[role="tablist"]')?.scrollIntoView({ block: "start" }));
    await shot("See the calls, decisions and results", 2.2);
    await hooks.finished();
    const list =
      frames.map(({ file, duration }) => `file '${file}'\nduration ${duration}\n`).join("") +
      `file '${frames.at(-1)!.file}'\n`;
    writeFileSync(join(dir, "frames.txt"), list);
  } catch (error) {
    await page.screenshot({ path: `${dir.split("/frames")[0]}.png`, fullPage: true }).catch(() => {});
    console.error(
      await page.$eval("body", (el) => (el as HTMLElement).innerText.slice(-7000)).catch(() => "Browser closed"),
    );
    throw error;
  } finally {
    await context.close();
  }
}
