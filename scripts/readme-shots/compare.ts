// `node scripts/readme-shots/compare.ts <before> <after> <out> <imageBase>`: compares two folders of stills
// (`shots.ts --out`) and writes to <out> each changed page's before, after and diff, and comment.md, the
// pull request comment .github/workflows/visual.yml posts, its images at <imageBase>. A diff is the
// after faded to grey with every changed pixel red.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const [before, after, out, imageBase] = process.argv.slice(2);
if (!before || !after || !out || imageBase === undefined) {
  console.error("usage: node scripts/readme-shots/compare.ts <before> <after> <out> <imageBase>");
  process.exit(2);
}

/** The comment's first line, by which visual.yml finds the comment to update. */
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

/** A table row: the page, what changed, and its images. */
function row(page: string, what: string, files: Partial<Record<"before" | "after" | "diff", string>>): string {
  return `| **${page}**<br>${what} | ${cell(files.before)} | ${cell(files.after)} | ${cell(files.diff)} |`;
}

/** An image's table cell, a link to it at full size; empty without one. */
function cell(file?: string): string {
  return file ? `<a href="${imageBase}${file}"><img src="${imageBase}${file}" width="260"></a>` : "";
}

mkdirSync(out, { recursive: true });
const had = pngs(before);
const names = [...new Set([...had, ...pngs(after)])].toSorted();
const rows: string[] = [];
const same: string[] = [];
for (const name of names) {
  const page = name.replace(/\.png$/, "");
  const [was, is] = [join(before, name), join(after, name)];
  const files = { before: `${page}.before.png`, after: `${page}.after.png`, diff: `${page}.diff.png` };
  if (!existsSync(was) || !existsSync(is)) {
    const isNew = existsSync(is);
    copyFileSync(isNew ? is : was, join(out, isNew ? files.after : files.before));
    rows.push(row(page, isNew ? "new" : "gone", isNew ? { after: files.after } : { before: files.before }));
    continue;
  }
  const a = read(was);
  const b = read(is);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const diff = new PNG({ width, height });
  const changed = pixelmatch(padded(b, width, height), padded(a, width, height), diff.data, width, height, {
    alpha: 0.25,
  });
  if (changed === 0) {
    same.push(page);
    continue;
  }
  copyFileSync(was, join(out, files.before));
  copyFileSync(is, join(out, files.after));
  writeFileSync(join(out, files.diff), PNG.sync.write(diff));
  const share = ((100 * changed) / (width * height)).toFixed(2);
  rows.push(row(page, `${share}% of pixels`, files));
}

const lines = [MARKER, "### Visual diff", ""];
if (rows.length === 0) lines.push(`No visual change in ${names.length} pages.`);
else {
  lines.push(
    "Pages whose pixels changed between this pull request's base and its head. In the diff, red marks a changed pixel.",
    "",
    "| Page | Before | After | Diff |",
    "| --- | --- | --- | --- |",
    ...rows,
  );
  if (same.length) lines.push("", `Unchanged: ${same.join(", ")}.`);
}
if (had.length === 0)
  lines.push("", "_The base took no screenshots (it predates them, or its run failed), so every page shows as new._");
writeFileSync(join(out, "comment.md"), `${lines.join("\n")}\n`);
console.log(`visual: ${rows.length} changed, ${same.length} unchanged`);
