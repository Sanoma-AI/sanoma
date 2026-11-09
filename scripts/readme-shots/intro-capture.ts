import type { Browser, Page } from "puppeteer-core";
import { REQUEST } from "./intro-fixture.ts";
import { MotionRecorder, pause } from "./motion.ts";

interface Hooks {
  say(line: string): void;
  diff(id: string): string;
  restart(): Promise<string>;
  waiting(): Promise<void>;
  finished(): Promise<void>;
}
async function textIs(page: Page, text: string, timeout = 120_000) {
  await page.waitForFunction((value) => document.body.innerText.includes(value), { timeout }, text);
}

/** Continuous screen recordings of real interactions; cuts skip builds, restarts and role changes. */
export async function captureIntro(browser: Browser, initialBase: string, dir: string, hooks: Hooks) {
  const motion = new MotionRecorder(dir);
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.evaluateOnNewDocument(() => {
    if (!localStorage.getItem("sanoma.actor")) localStorage.setItem("sanoma.actor", "dana");
  });
  let base = initialBase;
  async function navigate(path: string, actor = "dana", chat = false) {
    await context.setCookie({ name: "sanoma_chat", value: chat ? "open" : "closed", domain: new URL(base).hostname });
    if (new URL(page.url()).protocol === "http:")
      await page.evaluate((person) => localStorage.setItem("sanoma.actor", person), actor);
    await page.goto(base + path, { waitUntil: "networkidle0" });
    // A restarted app has a new origin. Select the intended demo person there as well.
    if (await page.evaluate((person) => localStorage.getItem("sanoma.actor") !== person, actor)) {
      await page.evaluate((person) => localStorage.setItem("sanoma.actor", person), actor);
      await page.reload({ waitUntil: "networkidle0" });
    }
  }
  try {
    hooks.say("recording the existing-plan selector and typed request as continuous video");
    await navigate("/workflows", "dana", true);
    await page.waitForSelector('select[aria-label="Engine"]');
    await motion.record(
      page,
      "Bring your existing Claude Code plan",
      async () => {
        await motion.click(page, 'select[aria-label="Engine"]');
        await page.keyboard.press("Escape");
        await page.select('select[aria-label="Engine"]', "acp-claude-code");
        await pause(1100);
      },
      "Agent choice shown; no Claude session recorded",
    );

    await motion.record(page, "Ask for a page, workflow and approval rule", async () => {
      await motion.click(page, 'select[aria-label="Engine"]');
      await page.keyboard.press("Escape");
      await page.select('select[aria-label="Engine"]', "loop");
      await motion.type(page, 'textarea[aria-label="Message the agent"]', REQUEST, 20);
      await motion.click(page, 'button[aria-label="Send"]');
      await pause(1200);
    });
    // The minutes spent building are an explicit edit, not a recording of an instant build.
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
    await motion.record(
      page,
      "A checked draft in your team's Git repo",
      async () => {
        await motion.point(page, '[aria-label="Draft"]');
        await pause(900);
        await motion.clickText(page, "button", "Send for review");
      },
      "Build wait condensed",
    );
    await page.waitForFunction(() => location.pathname.startsWith("/changes/"), { timeout: 120_000 });
    const id = new URL(page.url()).pathname.split("/").at(-1)!;
    await navigate(`/changes/${id}`, "engineer");
    await textIs(page, "Publish waits for admin", 240_000);
    await textIs(page, "pass");

    // A labelled view of actual added lines, not an invented editor on the Changes page.
    const diff = hooks.diff(id);
    if (!diff.includes("resend.emails.send") || !diff.includes('@hold("marketing-lead")'))
      throw new Error("Draft lacks workflow/permission change");
    const diffPage = await context.newPage();
    await diffPage.setViewport({ width: 1200, height: 900 });
    await diffPage.setContent(
      '<html><body style="margin:0;background:#f7f8f6;color:#172420;font:18px system-ui"><header style="padding:24px 34px;border-bottom:1px solid #d9dfda"><b>Review the draft · added lines from Git diff</b><div style="font-size:14px;margin-top:8px">workflows/announce.ts + policies/marketing.cedar</div></header><pre style="margin:0;padding:20px 34px;font:16px/1.2 ui-monospace,monospace;white-space:pre-wrap"></pre></body></html>',
    );
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
    await motion.record(diffPage, "Code and permission rules stay in Git", async () => {
      await motion.move(diffPage, 225, 150);
      await pause(800);
      await motion.move(diffPage, 480, 530, 800);
      await pause(900);
    });
    await diffPage.close();
    await page.bringToFront();

    await motion.record(page, "Review permissions. Approve the code change.", async () => {
      await motion.point(page, 'code::-p-text("resend.emails.send")');
      await pause(900);
      await motion.clickText(page, "button", "Publish");
      await page.waitForSelector('[role="dialog"]');
      await pause(450);
      await motion.clickText(page, '[role="dialog"] button', "Publish");
      await pause(500);
    });
    await textIs(page, "Published", 120_000);
    hooks.say("code change published; restarting on merged code");
    base = await hooks.restart();
    await navigate("/sites/launches", "dana");
    await page.waitForSelector("#field-title");
    // The finished tool opens the film; recording it here avoids inventing a draft preview.
    await motion.record(
      page,
      "A launch desk for your marketing team",
      async () => {
        await motion.point(page, "#field-title");
        await pause(1100);
      },
      "",
      true,
    );
    await motion.record(page, "Your coworker submits an announcement", async () => {
      await motion.type(page, "#field-title", "Our November workshop", 45);
      await motion.type(
        page,
        "#field-body",
        "Join Paperplane Studio for our November workshop. New ideas, practical examples and time for your questions.",
        22,
      );
      await motion.clickText(page, "button", "Start run");
      await pause(650);
    });
    await page.waitForSelector('a[href*="/runs/"]');
    const runPath = await page.$eval('a[href*="/runs/"]', (el) => el.getAttribute("href")!);
    await navigate(runPath);
    await page.waitForFunction(() => document.getElementById("run-status")?.textContent === "waiting");
    await hooks.waiting();
    await motion.record(page, "Publishing and email wait for approval", async () => {
      await motion.point(page, '[aria-label="Inspector"]');
      await pause(1100);
      await motion.point(page, 'a[href="/inbox"]');
    });
    await navigate("/inbox", "marketing-lead");
    await textIs(page, "Approve this announcement");
    await motion.record(page, "The marketing lead approves this announcement", async () => {
      await motion.clickText(page, "button", "Approve");
      await page.waitForSelector('[role="dialog"]');
      await motion.type(page, '[role="dialog"] textarea', "Copy approved. Ship it!", 45);
      await motion.clickText(page, '[role="dialog"] button', "Approve");
      await pause(700);
    });
    await navigate(runPath, "marketing-lead");
    await page.waitForFunction(() => document.getElementById("run-status")?.textContent === "finished", {
      timeout: 60_000,
    });
    await motion.record(page, "Ghost publishes. Resend sends the email.", async () => {
      await motion.click(page, '[aria-label="Inspector"] button[aria-label="Close"]');
      await motion.click(page, '[aria-label="Fit the graph"]');
      await pause(1000);
    });
    await motion.record(page, "See the calls, decisions and results", async () => {
      await motion.clickText(page, '[role="tab"]', "Ledger");
      await motion.scrollTo(page, '[role="tablist"]');
      await pause(1500);
    });
    await hooks.finished();
    return motion.writeList();
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
