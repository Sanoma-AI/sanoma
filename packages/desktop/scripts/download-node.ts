// The Node the shell runs a company with: the official build, pinned, checked against its sha256.
// Electron's own Node cannot be it: oxlint's JS plugins (`sanoma check`) need memory outside V8's
// heap, which Electron's V8 sandbox refuses (#292).
//
//   node scripts/download-node.ts                       # this platform, into stage/node-<arch>
//   node scripts/download-node.ts --platform darwin-x64 --out /tmp/node-x64
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
  version: "24.22.1",
  sha256: {
    "darwin-arm64": "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7",
    "darwin-x64": "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035",
    "linux-arm64": "33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3",
    "linux-x64": "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c",
  } as Record<string, string>,
};

/**
 * Puts `platform`'s Node binary and its LICENSE in `out` (`out/node`), unless the version there
 * is the pinned one already (`out/VERSION`). Writes nothing when the archive does not match.
 */
export async function downloadNode(platform: string, out: string): Promise<void> {
  const sha256 = NODE.sha256[platform];
  if (!sha256) throw new Error(`no pinned Node for ${platform}`);
  const version = join(out, "VERSION");
  if (existsSync(join(out, "node")) && existsSync(version) && readFileSync(version, "utf8").trim() === NODE.version) {
    return;
  }
  const name = `node-v${NODE.version}-${platform}`;
  const url = `https://nodejs.org/dist/v${NODE.version}/${name}.tar.gz`;
  console.error(`downloading ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  const archive = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(archive).digest("hex");
  if (got !== sha256) throw new Error(`${url}: sha256 ${got}, expected ${sha256}`);
  const work = mkdtempSync(join(tmpdir(), "sanoma-node-"));
  try {
    writeFileSync(join(work, "node.tar.gz"), archive);
    const tar = spawnSync("tar", ["-xzf", "node.tar.gz", `${name}/bin/node`, `${name}/LICENSE`], {
      cwd: work,
      stdio: "inherit",
    });
    if (tar.status !== 0) throw new Error(`could not extract ${name}`);
    mkdirSync(out, { recursive: true });
    // Beside it, then over it: a shell running from stage/ never sees half a binary.
    copyFileSync(join(work, name, "bin", "node"), join(out, "node.tmp"));
    renameSync(join(out, "node.tmp"), join(out, "node"));
    copyFileSync(join(work, name, "LICENSE"), join(out, "LICENSE"));
    writeFileSync(version, `${NODE.version}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { platform: { type: "string" }, out: { type: "string" } } });
  const platform = values.platform ?? `${process.platform}-${process.arch}`;
  const out = values.out ?? fileURLToPath(new URL(`../stage/node-${platform.split("-")[1]}`, import.meta.url));
  await downloadNode(platform, out);
  console.log(join(out, "node"));
}
