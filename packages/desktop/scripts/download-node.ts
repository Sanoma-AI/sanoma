// The Node the shell runs a company with: the official build, pinned, checked against its sha256.
// Electron's own Node cannot be it: oxlint's JS plugins (`sanoma check`) need memory outside V8's
// heap, which Electron's V8 sandbox refuses (#292).
//
//   node scripts/download-node.ts                       # this platform, into stage/node-<arch>
//   node scripts/download-node.ts --platform darwin-x64 --out /tmp/node-x64
//   node scripts/download-node.ts --platform win32-x64 --out /tmp/node-win   # node.exe, from the .zip
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The release, and the sha256 of each platform's archive: its line in the release's SHASUMS256.txt. */
export const NODE = {
  version: "26.12.1",
  sha256: {
    "darwin-arm64": "1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8",
    "darwin-x64": "b85c2ea4420ad0bc4abf2dc6cf1f55130ed681f1cabf60cf3f526e4c9e2712ff",
    "linux-arm64": "a6c01af459dd8972ab3fb08ee5da81244d26ba8c4944a62d5bbba8c597ae154f",
    "linux-x64": "0fd1eb7770598f52a21995edf6ed35fc690400fa437c2386af329519e9143132",
    "win32-arm64": "34567581ee63967b37afb6b7a0cc63a2d550a43d5d838adb75982d7e356f2e2c",
    "win32-x64": "b3efd5c70cba3308ed46e7e699a9b8aac075bbc6b027fcb39c84c31acc25e2b4",
  } as Record<string, string>,
};

/** What the release has for `platform` (`<os>-<arch>`, as `process.platform` and `process.arch` name them). */
export function archiveOf(platform: string) {
  const windows = platform.startsWith("win32-");
  // The release names Windows `win`, and ships it as a .zip with node.exe at its top.
  const name = `node-v${NODE.version}-${platform.replace(/^win32-/, "win-")}`;
  return {
    name,
    file: `${name}.${windows ? "zip" : "tar.gz"}`,
    /** The binary's path in the archive, and its name in `out`. */
    entry: windows ? `${name}/node.exe` : `${name}/bin/node`,
    binary: windows ? "node.exe" : "node",
  };
}

/**
 * The tar that reads the archive. A .zip needs bsdtar, which reads zip as well: macOS's `tar`, and
 * Windows 10's and later's System32\tar.exe, named by its path because Git for Windows can put its
 * GNU tar (which reads no zip) first on PATH. Linux's GNU tar cannot: a Windows Node is staged on
 * Windows or macOS.
 */
function tarFor(file: string): string {
  if (!file.endsWith(".zip")) return "tar";
  if (process.platform === "win32") return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  if (process.platform === "darwin") return "tar";
  throw new Error(`${file} is a zip, which only bsdtar reads: stage a Windows Node on Windows or macOS`);
}

/**
 * Puts `platform`'s Node binary (`node`, or `node.exe` on Windows) and its LICENSE in `out`,
 * unless the version there is the pinned one already (`out/VERSION`). Writes nothing when the
 * archive does not match.
 */
export async function downloadNode(platform: string, out: string): Promise<void> {
  const sha256 = NODE.sha256[platform];
  if (!sha256) throw new Error(`no pinned Node for ${platform}`);
  const { name, file, entry, binary } = archiveOf(platform);
  const version = join(out, "VERSION");
  if (existsSync(join(out, binary)) && existsSync(version) && readFileSync(version, "utf8").trim() === NODE.version) {
    return;
  }
  // Before the download: why it cannot be read.
  const tar = tarFor(file);
  const url = `https://nodejs.org/dist/v${NODE.version}/${file}`;
  console.error(`downloading ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  const archive = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(archive).digest("hex");
  if (got !== sha256) throw new Error(`${url}: sha256 ${got}, expected ${sha256}`);
  const work = mkdtempSync(join(tmpdir(), "sanoma-node-"));
  try {
    writeFileSync(join(work, file), archive);
    // bsdtar and GNU tar both tell a gzip from its contents; a zip only bsdtar reads (`tarFor`).
    const extracted = spawnSync(tar, ["-xf", file, entry, `${name}/LICENSE`], { cwd: work, stdio: "inherit" });
    if (extracted.status !== 0) throw new Error(`could not extract ${name} from ${file}`);
    mkdirSync(out, { recursive: true });
    // Beside it, then over it: a shell running from stage/ never sees half a binary.
    copyFileSync(join(work, ...entry.split("/")), join(out, `${binary}.tmp`));
    renameSync(join(out, `${binary}.tmp`), join(out, binary));
    copyFileSync(join(work, name, "LICENSE"), join(out, "LICENSE"));
    writeFileSync(version, `${NODE.version}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { platform: { type: "string" }, out: { type: "string" } } });
  const platform = values.platform ?? `${process.platform}-${process.arch}`;
  // This platform's goes where stage.ts puts it; another's beside it, never into this one's folder.
  const host = platform === `${process.platform}-${process.arch}`;
  const folder = `node-${host ? process.arch : platform}`;
  const out = values.out ?? fileURLToPath(new URL(`../stage/${folder}`, import.meta.url));
  await downloadNode(platform, out);
  console.log(join(out, archiveOf(platform).binary));
}
