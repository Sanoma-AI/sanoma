// The browser half of `pnpm readme:shots`: the demo's storyboard, the seeded runs and the stills,
// each scene in a fresh browser context of a local Chrome, light theme.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type ElementHandle, launch, type Page } from "puppeteer-core";
import { RAIL_COOKIE } from "../../packages/app/src/lib/rail.ts";

/**
 * The installed Google Chrome, or the binary `CHROME_PATH` names, in US English (where Chrome
 * takes its locale from `--lang` or `LANG`; on macOS it follows the system's), so a date field
 * reads month/day/year. It leaves SIGINT, SIGTERM and SIGHUP to the script, which closes it.
 */
export async function launchChrome(): Promise<Browser> {
  try {
    return await launch({
      channel: "chrome",
      executablePath: process.env.CHROME_PATH,
      headless: true,
      args: ["--lang=en-US"],
      env: { ...process.env, LANG: "en_US.UTF-8" },
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  } catch (err) {
    throw new Error(
      `readme:shots: could not start ${process.env.CHROME_PATH ?? "Google Chrome"}; install Chrome or set CHROME_PATH to a Chrome or Chromium binary`,
      { cause: err },
    );
  }
}

interface Scene {
  actor: string;
  /** The sidebar open, or folded to its icons. */
  sidebar: boolean;
  width: number;
  height: number;
  scale: number;
}

/** dana at 1200×800 with the sidebar folded: the demo's scene, and the seeding's. */
const DANA: Scene = { actor: "dana", sidebar: false, width: 1200, height: 800, scale: 1 };

/**
 * A page in a context of its own, with the actor, sidebar and viewport of `scene`, the workflow's
 * rail of runs folded to its dots, and the light theme (the app follows the system's by default).
 */
async function open(browser: Browser, base: string, scene: Scene): Promise<Page> {
  const context = await browser.createBrowserContext();
  await context.setCookie(
    { name: "sidebar_state", value: String(scene.sidebar), domain: new URL(base).hostname },
    { name: RAIL_COOKIE, value: "collapsed", domain: new URL(base).hostname },
  );
  const page = await context.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  // The app keeps the actor in localStorage; set only once, so a scene can switch it.
  await page.evaluateOnNewDocument((actor) => {
    if (!localStorage.getItem("sanoma.actor")) localStorage.setItem("sanoma.actor", actor);
  }, scene.actor);
  await page.setViewport({ width: scene.width, height: scene.height, deviceScaleFactor: scene.scale });
  page.on("pageerror", (err) => console.warn(`readme:shots: page error on ${page.url()}: ${String(err)}`));
  return page;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The first element matching `selector` whose text is `text`. */
async function byText(page: Page, selector: string, text: string): Promise<ElementHandle> {
  for (const el of await page.$$(selector)) if ((await el.evaluate((e) => e.textContent?.trim())) === text) return el;
  throw new Error(`readme:shots: no ${selector} reading "${text}" on ${page.url()}`);
}

async function need(page: Page, selector: string): Promise<ElementHandle> {
  const el = await page.$(selector);
  if (!el) throw new Error(`readme:shots: no ${selector} on ${page.url()}`);
  return el;
}

/** Waits until the run's page shows `status`; on timeout, names the status it shows instead. */
async function statusIs(page: Page, status: string, timeout = 120_000): Promise<void> {
  try {
    await page.waitForFunction((t) => document.getElementById("run-status")?.textContent === t, { timeout }, status);
  } catch (err) {
    const seen = await page.evaluate(() => document.getElementById("run-status")?.textContent).catch(() => undefined);
    throw new Error(`readme:shots: the run on ${page.url()} is ${seen ?? "not shown"}, not ${status}`, { cause: err });
  }
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** `when` as a datetime-local field's value: local time, to the minute. */
const fieldValue = (when: Date) =>
  `${when.getFullYear()}-${p2(when.getMonth() + 1)}-${p2(when.getDate())}T${p2(when.getHours())}:${p2(when.getMinutes())}`;

/**
 * Types a datetime-local field's parts, as US English lays them out: month, day, year, then
 * hours, minutes, AM or PM. Checks the field read them so, since another locale orders them otherwise.
 */
async function typeDateTime(page: Page, selector: string, when: Date, each: () => Promise<void>) {
  const hours = when.getHours();
  for (const part of [p2(when.getMonth() + 1), p2(when.getDate()), String(when.getFullYear())]) {
    await page.keyboard.type(part);
    await each();
  }
  await page.keyboard.press("ArrowRight");
  for (const part of [p2(hours % 12 || 12), p2(when.getMinutes()), hours >= 12 ? "P" : "A"]) {
    await page.keyboard.type(part);
    await each();
  }
  const value = await page.$eval(selector, (e) => (e as HTMLInputElement).value);
  if (value !== fieldValue(when)) {
    throw new Error(
      `readme:shots: typed ${fieldValue(when)} as month/day/year, but the field reads "${value}": Chrome lays out dates in another locale's order (on macOS, the system's)`,
    );
  }
}

/** Sets a datetime-local field to `when` whatever its layout, as an input event the form hears. */
async function setDateTime(page: Page, selector: string, when: Date): Promise<void> {
  await page.$eval(
    selector,
    (e, value) => {
      const input = e as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    fieldValue(when),
  );
}

/**
 * demo.gif's storyboard, at 1200×800: dana starts a run of announce from New run with a launch time
 * about a minute away, marketing-lead approves it in the Inbox with a note, and the run sleeps until
 * the launch, then finishes. Each frame is a screenshot shown for its own duration; a drawn cursor
 * moves to what is clicked. Writes the frames and their list for ffmpeg's concat demuxer
 * (`frames.txt`) to `dir`, and returns the run's path.
 */
export async function recordDemo(browser: Browser, base: string, dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const page = await open(browser, base, DANA);
  await page.evaluateOnNewDocument(() => {
    addEventListener("DOMContentLoaded", () => {
      const cursor = document.createElement("div");
      cursor.id = "fake-cursor";
      const [x, y] = (sessionStorage.getItem("fake.cursor") ?? "600,420").split(",");
      cursor.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:2147483647;pointer-events:none;transition:left .4s ease-in-out,top .4s ease-in-out,transform .08s;transform-origin:2px 2px;`;
      cursor.innerHTML =
        '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2 L2 21 L7 16.5 L10.5 24 L14 22.5 L10.5 15 L17 15 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      document.documentElement.appendChild(cursor);
    });
  });

  const frames: [file: string, seconds: number][] = [];
  const shot = async (seconds: number) => {
    const file = `${String(frames.length + 1).padStart(3, "0")}.png`;
    await page.screenshot({ path: join(dir, file) });
    frames.push([file, seconds]);
  };
  const transform = (value: string) =>
    page.$eval("#fake-cursor", (c, to) => ((c as HTMLElement).style.transform = to), value);
  /** Glides the cursor to `el`'s centre plus (dx, dy), in three frames; returns that point. */
  const moveTo = async (el: ElementHandle, dx = 0, dy = 0): Promise<[x: number, y: number]> => {
    const box = await el.boundingBox();
    if (!box) throw new Error("readme:shots: moving to an element that is not shown");
    const x = Math.round(box.x + box.width / 2 + dx);
    const y = Math.round(box.y + box.height / 2 + dy);
    await page.$eval(
      "#fake-cursor",
      (c, left, top) => {
        Object.assign((c as HTMLElement).style, { left: `${left}px`, top: `${top}px` });
        sessionStorage.setItem("fake.cursor", `${left},${top}`);
      },
      x,
      y,
    );
    for (let i = 0; i < 3; i++) {
      await wait(130);
      await shot(0.13);
    }
    await wait(100);
    return [x, y];
  };
  const press = async () => {
    await transform("scale(.85)");
    await shot(0.12);
    await transform("");
  };
  const click = async (el: ElementHandle, dx = 0, dy = 0) => {
    const [x, y] = await moveTo(el, dx, dy);
    await press();
    await page.mouse.click(x, y);
  };
  const typeIn = async (selector: string, text: string, step: number) => {
    await page.focus(selector);
    for (let i = 0; i < text.length; i += step) {
      await page.keyboard.type(text.slice(i, i + step));
      await shot(0.07);
    }
  };

  // 1. The workflow's page.
  await page.goto(`${base}/workflows/announce`, { waitUntil: "networkidle0" });
  await wait(2000);
  await shot(2.2);
  // 2. New run: the form, filled in.
  await click(await byText(page, "a", "New run"));
  await wait(900);
  await shot(0.9);
  await click(await need(page, "#field-title"));
  await typeIn("#field-title", "Spring launch", 2);
  await click(await need(page, "#field-body"));
  await typeIn("#field-body", "<p>Spring is here: new templates, faster sync and a fresh look.</p>", 6);
  // The field takes whole minutes: the first minute at least 30 s away, so the run is still
  // sleeping when the demo comes back to it (about 20 s later) and finishes within 90 s.
  const launchAt = new Date(Math.ceil((Date.now() + 30_000) / 60_000) * 60_000);
  const field = await need(page, "#field-launchAt");
  const box = (await field.boundingBox())!;
  await click(field, 22 - box.width / 2);
  await typeDateTime(page, "#field-launchAt", launchAt, () => shot(0.1));
  await shot(0.8);
  // 3. Start run: the run's page, waiting on the approval.
  await click(await byText(page, "button", "Start run"));
  await page.waitForFunction(() => location.pathname.includes("/runs/"));
  await statusIs(page, "waiting");
  await wait(1500);
  await shot(2.6);
  const runPath = new URL(page.url()).pathname;
  // 4. The Inbox, as marketing-lead.
  await moveTo(await need(page, 'a[href="/inbox"]'));
  await press();
  await page.evaluate(() => localStorage.setItem("sanoma.actor", "marketing-lead"));
  await page.goto(`${base}/inbox`, { waitUntil: "networkidle0" });
  await wait(1500);
  await shot(2.4);
  // 5. Approve there, with a note.
  await click(await byText(page, "button", "Approve"));
  await wait(600);
  await shot(0.6);
  await typeIn('[role="dialog"] textarea', "Copy looks good, ship it", 3);
  await shot(0.6);
  await click(await byText(page, '[role="dialog"] button', "Approve"));
  await wait(1500);
  await shot(1.6);
  // 6. Back to the run: sleeping until the launch, then finished, then its ledger.
  const workflows = (await page.$$('a[href="/workflows"]')).at(-1);
  if (!workflows) throw new Error("readme:shots: no link to /workflows");
  await moveTo(workflows);
  await press();
  await page.goto(base + runPath, { waitUntil: "networkidle0" });
  await wait(1800);
  // Sleeping until the launch, which a run shows as running: a finished one would tell another story.
  await statusIs(page, "running", 5000);
  await shot(2.2);
  await statusIs(page, "finished");
  await wait(2500);
  await shot(1.8);
  for (let i = 1; i <= 6; i++) {
    await page.evaluate((y) => scrollTo(0, y), i * 100);
    await wait(60);
    await shot(0.06);
  }
  await page.evaluate(() =>
    scrollTo(0, document.querySelector('[role="tab"]')!.getBoundingClientRect().top + scrollY - 70),
  );
  await wait(500);
  await moveTo(await byText(page, '[role="tab"]', "Ledger"), 40, 10);
  await shot(3.5);
  await page.browserContext().close();

  // The concat demuxer takes the last frame's duration only when that frame is listed again.
  const list =
    frames.map(([file, seconds]) => `file '${file}'\nduration ${seconds}\n`).join("") + `file '${frames.at(-1)![0]}'\n`;
  writeFileSync(join(dir, "frames.txt"), list);
  return runPath;
}

/** Two more runs of announce from dana, waiting on marketing-lead, for the Inbox still. */
export async function seedPendingRuns(browser: Browser, base: string): Promise<void> {
  const page = await open(browser, base, DANA);
  let previous = "";
  for (const [title, body, launchAt] of [
    ["Summer sale", "<p>Everything is 20% off until Sunday.</p>", new Date(2027, 5, 1, 9)],
    ["Pricing update", "<p>New plans for teams, from next month.</p>", new Date(2027, 5, 15, 10)],
  ] as const) {
    await page.goto(`${base}/workflows/announce?new`, { waitUntil: "networkidle0" });
    await page.waitForSelector("#field-title");
    await page.type("#field-title", title);
    await page.type("#field-body", body);
    await setDateTime(page, "#field-launchAt", launchAt);
    await (await byText(page, "button", "Start run")).click();
    await page.waitForFunction(
      (prev) => location.pathname.includes("/runs/") && location.pathname !== prev,
      { timeout: 30_000 },
      previous,
    );
    previous = new URL(page.url()).pathname;
    await statusIs(page, "waiting");
  }
  await page.browserContext().close();
}

export interface Still {
  sidebar: boolean;
  /** The viewport's height in CSS pixels (default 900); the width is 1440 and the scale 2. */
  height?: number;
  /** All of the page: the viewport grown to its height, so the sidebar runs the whole length. */
  fullPage?: boolean;
  /** Open the tab of this name. */
  tab?: string;
  /** Fit all of the graph to its pane, then select the node whose text includes this. */
  select?: string;
}

/** A 2x still of `path` as marketing-lead, with the rail of runs folded to its dots. */
export async function still(browser: Browser, base: string, path: string, out: string, options: Still): Promise<void> {
  let height = options.height ?? 900;
  const page = await open(browser, base, {
    actor: "marketing-lead",
    sidebar: options.sidebar,
    width: 1440,
    height,
    scale: 2,
  });
  await page.goto(base + path, { waitUntil: "networkidle0" });
  if (options.select) await page.waitForSelector(".react-flow__node");
  if (options.tab) await (await page.waitForSelector(`[role="tab"]::-p-text(${JSON.stringify(options.tab)})`))!.click();
  // Grown before the graph is fitted: a resize fits it again, to one end. (A fullPage screenshot
  // resizes too, after the fit.)
  while (options.fullPage) {
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    if (pageHeight <= height) break;
    height = pageHeight;
    await page.setViewport({ width: 1440, height, deviceScaleFactor: 2 });
    await wait(500);
  }
  if (options.select) {
    // Fitting animates for 300 ms.
    await page.click('[aria-label="Fit the graph"]');
    await wait(800);
    const node = await page.$(`.react-flow__node::-p-text(${JSON.stringify(options.select)})`);
    if (!node) throw new Error(`readme:shots: no graph node reading "${options.select}" on ${path}`);
    await node.click();
    await wait(800);
  }
  // Out of the way of any hover style.
  await page.mouse.move(1, height - 1);
  await wait(800);
  await page.screenshot({ path: out as `${string}.png` });
  await page.browserContext().close();
}
