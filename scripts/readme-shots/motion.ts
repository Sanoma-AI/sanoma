import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import type { Page } from "puppeteer-core";

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function videoInfo(path: string): { duration: number; width: number; height: number } {
  const info = JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration:stream=width,height", "-of", "json", path],
      { encoding: "utf8" },
    ),
  );
  const duration = Number(info.format.duration);
  assert(Number.isFinite(duration) && duration > 0, `Invalid video duration: ${path}`);
  return { duration, width: info.streams[0].width, height: info.streams[0].height };
}

/** Continuous Chrome video clips, with a visible pointer following the actual mouse events. */
export class MotionRecorder {
  private readonly clips: string[] = [];
  private duration = 0;
  private readonly positions = new WeakMap<Page, { x: number; y: number }>();
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  /** A cut only between scenes; the action itself is recorded continuously, including typing and clicks. */
  async record(page: Page, caption: string, action: () => Promise<void>, detail = "", opening = false) {
    await page.bringToFront();
    // setViewport emulates layout size; native video also needs the actual window's content size.
    // Closing the diff tab can otherwise shrink the window and crop the next clip.
    await page.resize({ contentWidth: 1200, contentHeight: 900 });
    await this.decorate(page, caption, detail);
    const file = `${String(this.clips.length).padStart(3, "0")}.mp4`;
    const recording = await page.record({ fps: 20, maxWidth: 1200, maxHeight: 900 });
    const output = createWriteStream(join(this.dir, file));
    const stored = finished(output);
    // A disk failure is reported below, after stopping Chrome's recorder too.
    void stored.catch(() => {});
    recording.pipe(output);
    try {
      await pause(200);
      await action();
      await pause(300);
    } finally {
      await recording.stop().catch((error: unknown) => {
        output.destroy();
        throw error;
      });
      await stored;
    }
    const info = videoInfo(join(this.dir, file));
    assert.equal(info.width, 1200, `Unexpected recording width: ${file}`);
    assert.equal(info.height, 900, `Unexpected recording height: ${file}`);
    this.duration += info.duration;
    if (opening) this.clips.unshift(file);
    else this.clips.push(file);
  }

  writeList() {
    writeFileSync(join(this.dir, "clips.txt"), this.clips.map((file) => `file '${file}'\n`).join(""));
    return this.duration;
  }

  async move(page: Page, x: number, y: number, milliseconds = 550) {
    const from = this.positions.get(page) ?? { x: 650, y: 450 };
    const steps = Math.max(1, Math.round(milliseconds / 20));
    const start = performance.now();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const eased = t * t * (3 - 2 * t);
      await page.mouse.move(from.x + (x - from.x) * eased, from.y + (y - from.y) * eased);
      await pause(Math.max(0, start + (i * milliseconds) / steps - performance.now()));
    }
    this.positions.set(page, { x, y });
  }

  async point(page: Page, selector: string) {
    const element = await page.waitForSelector(selector, { visible: true, timeout: 120_000 });
    if (!element) throw new Error(`No visible ${selector}`);
    const box = await element.boundingBox();
    if (!box) throw new Error(`No bounds for ${selector}`);
    if (box.y < 0 || box.y + box.height > 800) {
      await element.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
      await pause(450);
    }
    const at = (await element.boundingBox())!;
    await this.move(page, at.x + at.width / 2, at.y + at.height / 2);
  }

  async click(page: Page, selector: string) {
    await this.point(page, selector);
    await page.mouse.down();
    await pause(110);
    await page.mouse.up();
    await pause(220);
  }

  async clickText(page: Page, selector: string, text: string) {
    await this.click(page, `${selector}::-p-text(${JSON.stringify(text)})`);
  }

  async type(page: Page, selector: string, text: string, delay = 28) {
    await this.click(page, selector);
    await page.keyboard.type(text, { delay });
    await pause(250);
  }

  async scrollTo(page: Page, selector: string) {
    await this.move(page, 1080, 700);
    const y = await page.$eval(selector, (el) => el.getBoundingClientRect().top + scrollY - 24);
    await page.evaluate((top) => scrollTo({ top, behavior: "smooth" }), y);
    await pause(700);
  }

  private async decorate(page: Page, caption: string, detail: string) {
    const position = this.positions.get(page) ?? { x: 650, y: 450 };
    await page.evaluate(
      ({ title, note, point }) => {
        document.getElementById("recording-caption")?.remove();
        if (!document.getElementById("recording-style")) {
          const style = document.createElement("style");
          style.id = "recording-style";
          style.textContent = `#chat { height:calc(100svh - 100px)!important; } body { padding-bottom:110px; }
          @keyframes recording-click { from { transform:translate(-50%,-50%) scale(.3); opacity:.9; } to { transform:translate(-50%,-50%) scale(1.5); opacity:0; } }`;
          document.head.append(style);
        }
        if (!document.getElementById("recording-cursor")) {
          const cursor = document.createElement("div");
          cursor.id = "recording-cursor";
          cursor.style.cssText = `position:fixed;left:${point.x}px;top:${point.y}px;z-index:2147483646;pointer-events:none;transform-origin:2px 2px;filter:drop-shadow(0 1px 2px #0006);`;
          cursor.innerHTML =
            '<svg width="24" height="28" viewBox="0 0 24 28"><path d="M2 2V23L8 17.5L12 26L16 24L12 16H21Z" fill="#152821" stroke="white" stroke-width="1.7" stroke-linejoin="round"/></svg>';
          document.body.append(cursor);
          addEventListener("mousemove", (event) => {
            cursor.style.left = `${event.clientX}px`;
            cursor.style.top = `${event.clientY}px`;
          });
          addEventListener("mousedown", (event) => {
            cursor.style.transform = "scale(.85)";
            const ring = document.createElement("div");
            ring.style.cssText = `position:fixed;left:${event.clientX}px;top:${event.clientY}px;width:32px;height:32px;border:2px solid #23765e;border-radius:50%;background:#23765e20;pointer-events:none;z-index:2147483645;animation:recording-click .5s ease-out forwards;`;
            document.body.append(ring);
            ring.addEventListener("animationend", () => ring.remove(), { once: true });
          });
          addEventListener("mouseup", () => {
            cursor.style.transform = "";
          });
        }
        const bar = document.createElement("div");
        bar.id = "recording-caption";
        bar.style.cssText =
          "position:fixed;inset:auto 0 0;z-index:2147483647;background:#172420;color:#fff;padding:16px 28px 18px;font:600 24px/1.3 system-ui;pointer-events:none;box-shadow:0 -1px 0 #ffffff30";
        const main = document.createElement("div");
        main.textContent = title;
        bar.append(main);
        const small = document.createElement("div");
        small.style.cssText = "margin-top:7px;font:13px/1.4 system-ui;color:#c3d1ca";
        small.textContent = `Demo · scripted AI, simulated Git host & service calls${note ? ` · ${note}` : ""}`;
        bar.append(small);
        document.body.append(bar);
      },
      { title: caption, note: detail, point: position },
    );
    await page.mouse.move(position.x, position.y);
  }
}
