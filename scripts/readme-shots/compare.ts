// `node scripts/readme-shots/compare.ts <before> <after> <out> <imageBase>`: compares the stills of two folders
// (`pnpm readme:shots --out`) and writes, for each that changed, its before, after and diff to <out>,
// with comment.md: the pull request comment .github/workflows/visual.yml posts, its images at <imageBase>.
// A diff is the after faded to grey with every changed pixel red, so a change shows where it is at a glance.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const [before, after, out, imageBase] = process.argv.slice(2);
if (!before || !after || !out || imageBase === undefined) {
  console.error("usage: node scripts/readme-shots/compare.ts <before> <after> <out> <imageBase>");
  process.exit(2);
}

/** The comment's first line, by which the workflow finds the comment to update. */
const MARKER = "<!-- visual-diff -->";

const pngs = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".png")) : []);
const read = (file: string) => PNG.sync.read(readFileSync(file));

/** `image` on a white canvas `width` × `height`, so two stills of different heights compare. */
function padded(image: PNG, width: number, height: number): Buffer {
  if (image.width === width && image.height === height) return image.data;
  const canvas = new PNG({ width, height, fill: true });
  canvas.data.fill(255);
  PNG.bitblt(image, canvas, 0, 0, image.width, image.height, 0, 0);
  return canvas.data;
}

mkdirSync(out, { recursive: true });
const names = [...new Set([...pngs(before), ...pngs(after)])].toSorted();
const rows: string[] = [];
const same: string[] = [];
for (const name of names) {
  const page = name.replace(/\.png$/, "");
  const [was, is] = [join(before, name), join(after, name)];
  if (!existsSync(was) || !existsSync(is)) {
    const [kept, label] = existsSync(is) ? [is, "after"] : [was, "before"];
    copyFileSync(kept, join(out, `${page}.${label}.png`));
    rows.push(row(page, existsSync(is) ? "new" : "gone", { [label]: `${page}.${label}.png` }));
    continue;
  }
  const a = read(was);
  const b = read(is);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const diff = new PNG({ width, height });
  const changed = pixelmatch(padded(b, width, height), padded(a, width, height), diff.data, width, height, {
    threshold: 0.1,
    alpha: 0.25,
  });
  if (changed === 0) {
    same.push(page);
    continue;
  }
  copyFileSync(was, join(out, `${page}.before.png`));
  copyFileSync(is, join(out, `${page}.after.png`));
  writeFileSync(join(out, `${page}.diff.png`), PNG.sync.write(diff));
  const share = ((100 * changed) / (width * height)).toFixed(2);
  rows.push(
    row(page, `${share}% of pixels`, {
      before: `${page}.before.png`,
      after: `${page}.after.png`,
      diff: `${page}.diff.png`,
    }),
  );
}

/** An image's table cell, a link to it at full size; empty without one. */
function cell(file?: string): string {
  return file ? `<a href="${imageBase}${file}"><img src="${imageBase}${file}" width="260"></a>` : "";
}

/** A table row: the page, what changed, and its images (each a link to the full size). */
function row(page: string, what: string, images: Partial<Record<"before" | "after" | "diff", string>>): string {
  return `| **${page}**<br>${what} | ${cell(images.before)} | ${cell(images.after)} | ${cell(images.diff)} |`;
}

const lines = [MARKER, "### Visual diff", ""];
if (rows.length === 0) {
  lines.push(names.length ? `No visual change in ${names.length} pages.` : "No screenshots were taken.");
} else {
  lines.push(
    "Pages whose pixels changed between this pull request's base and its head. In the diff, red marks a changed pixel.",
    "",
    "| Page | Before | After | Diff |",
    "| --- | --- | --- | --- |",
    ...rows,
  );
  if (same.length) lines.push("", `Unchanged: ${same.join(", ")}.`);
}
if (pngs(before).length === 0 && names.length) {
  lines.push("", "_The base took no screenshots (it predates them, or its run failed), so every page shows as new._");
}
writeFileSync(join(out, "comment.md"), `${lines.join("\n")}\n`);
console.log(`visual: ${rows.length} changed, ${same.length} unchanged`);
