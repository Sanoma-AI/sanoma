// Draws icons/icon.icns and icons/icon.ico (forge.config.mts) from icons/icon.svg and, where the S
// is small, icons/icon-small.svg, in the computer's Chrome. Run it by hand on a Mac after changing
// a drawing, and commit the results.
//
//   node packages/desktop/scripts/icons.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const icons = fileURLToPath(new URL("../icons/", import.meta.url));
const large = readFileSync(join(icons, "icon.svg"), "utf8");
const small = readFileSync(join(icons, "icon-small.svg"), "utf8");
// In a square this size or under, icon.svg's fine strokes break up.
const SMALL_SQUARE = 52;

const browser = await chromium.launch({ channel: "chrome" });
// One viewport for every size: a screenshot taken just after resizing can repeat a stale strip.
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });

async function png(svg: string, size: number): Promise<Buffer> {
  await page.setContent(`<!doctype html><style>body{margin:0}body>svg{display:block;width:${size}px}</style>${svg}`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

/** The drawing with the square filling the canvas, for a square of `size` px. */
const square = (size: number) => (size <= SMALL_SQUARE ? small : large);

// macOS masks nothing, so the canvas has Apple's margin and shadow: a square of 824 on 1024.
const onMargin = (size: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-opacity="0.3" />
    </filter>
    <g filter="url(#shadow)"><svg x="100" y="100" width="824" height="824">${square((size * 824) / 1024)}</svg></g>
  </svg>`;

const scratch = mkdtempSync(join(tmpdir(), "sanoma-icons-"));
const iconset = join(scratch, "icon.iconset");
mkdirSync(iconset);
for (const points of [16, 32, 128, 256, 512]) {
  writeFileSync(join(iconset, `icon_${points}x${points}.png`), await png(onMargin(points), points));
  writeFileSync(join(iconset, `icon_${points}x${points}@2x.png`), await png(onMargin(points * 2), points * 2));
}
execFileSync("iconutil", ["--convert", "icns", "--output", join(icons, "icon.icns"), iconset]);
rmSync(scratch, { recursive: true });

/** A frame as an ICO's readers have long expected it: a header, BGRA rows from the bottom up, an empty mask. */
async function bitmap(data: Buffer, size: number): Promise<Buffer> {
  // A string, as this script's types have no DOM.
  const rgba = await page.evaluate<number[]>(`(async () => {
    const image = await createImageBitmap(await (await fetch("data:image/png;base64,${data.toString("base64")}")).blob());
    const context = new OffscreenCanvas(${size}, ${size}).getContext("2d");
    context.drawImage(image, 0, 0);
    return [...context.getImageData(0, 0, ${size}, ${size}).data];
  })()`);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // the pixels and the mask
  header.writeUInt16LE(1, 12); // colour planes
  header.writeUInt16LE(32, 14); // bits per pixel
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [from, to] = [(y * size + x) * 4, ((size - 1 - y) * size + x) * 4];
      pixels.set([rgba[from + 2]!, rgba[from + 1]!, rgba[from]!, rgba[from + 3]!], to);
    }
  }
  // One bit a pixel, in rows of whole 4-byte words; the alpha decides, so all of it is zero.
  return Buffer.concat([header, pixels, Buffer.alloc(size * Math.ceil(size / 32) * 4)]);
}

// Windows: the square fills the canvas. An ICO is a header and a directory of frames, in the usual
// form: a PNG at 256 (written as 0 in the directory), and bitmaps under that.
const entries: { size: number; data: Buffer }[] = [];
for (const size of [16, 24, 32, 48, 64, 128, 256]) {
  const data = await png(square(size), size);
  entries.push({ size, data: size === 256 ? data : await bitmap(data, size) });
}
await browser.close();

const header = Buffer.alloc(6 + 16 * entries.length);
header.writeUInt16LE(1, 2); // an icon
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach(({ size, data }, index) => {
  const entry = 6 + 16 * index;
  header.writeUInt8(size % 256, entry);
  header.writeUInt8(size % 256, entry + 1);
  header.writeUInt16LE(1, entry + 4); // colour planes
  header.writeUInt16LE(32, entry + 6); // bits per pixel
  header.writeUInt32LE(data.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += data.length;
});
writeFileSync(join(icons, "icon.ico"), Buffer.concat([header, ...entries.map(({ data }) => data)]));
