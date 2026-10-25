// `pnpm postgres:download`: fills this machine's `@sanoma-ai/postgres-<platform>` package
// (packages/postgres-bin/<platform>/) with the PostgreSQL server `RELEASE` pins: zonky's jar from
// Maven Central, checked against its sha256, made into `postgres.tar.gz` (`bin/`, `lib/`,
// `share/`) and `postgres.json` (`{ "postgres": <version>, "sha256": <the archive's> }`). Each
// package's prepack runs it for its own platform (`--platform`). `--check` downloads nothing: it
// extracts the package's archive into a temporary directory and runs `bin/postgres --version`.
//
//   pnpm postgres:download                       # this platform's package
//   pnpm postgres:download --platform win32-x64
//   pnpm postgres:download --check               # this platform's package, as it is
//
// Needs `unzip`, and `tar` with xz (`tar -xJf`). Node has no xz, so the archive is gzip.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** A PostgreSQL release of zonky's embedded-postgres-binaries, and its jar for each platform. */
export interface Release {
  /** The jars' Maven version, e.g. "18.6.0". */
  version: string;
  /** Each platform's artifact suffix (`embedded-postgres-binaries-<artifact>`) and the hex sha256 of its jar, by `${process.platform}-${process.arch}`. */
  jars: Record<string, { artifact: string; sha256: string }>;
}

/**
 * The release the platform packages ship. The sha256s are of the jars as Maven Central served
 * them, computed by hand, never fetched; a new PostgreSQL release means new entries here and a
 * new version of the five packages.
 */
export const RELEASE: Release = {
  version: "18.6.0",
  jars: {
    "darwin-arm64": {
      artifact: "darwin-arm64v8",
      sha256: "8f6ed6f38195b50a40712ada8b2a12060b6193c1a6977a6eb5cff053bb5a1b89",
    },
    "darwin-x64": {
      artifact: "darwin-amd64",
      sha256: "690941008aac9ee360820fde9bb7870a4f3dcac5e9e2f9e45e42333a436ad0f9",
    },
    "linux-arm64": {
      artifact: "linux-arm64v8",
      sha256: "5f54e016723afa6213925a8acb939bac52944b1d348f65c7a20f0cd2928c31be",
    },
    "linux-x64": {
      artifact: "linux-amd64",
      sha256: "008ee189eaa7ca2b58bd01dd950291e638b998392cf982297acd4779ec898ac1",
    },
    "win32-x64": {
      artifact: "windows-amd64",
      sha256: "b7ef2d03588e0439f0d0a2250f43905f7464f1e96ace47703ceaf79094198150",
    },
  },
};

/** The `@sanoma-ai/postgres-<platform>` package's directory. */
export function packageDir(platform: string): string {
  return fileURLToPath(new URL(`../../postgres-bin/${platform}/`, import.meta.url));
}

/**
 * Downloads `platform`'s jar of `release`, checks it against its pinned sha256 and writes the
 * package's `postgres.tar.gz` and `postgres.json`. Returns the archive's path. Writes nothing
 * when the check fails.
 */
export async function downloadPostgres(
  platform: string = `${process.platform}-${process.arch}`,
  release: Release = RELEASE,
): Promise<string> {
  const jar = release.jars[platform];
  if (!jar) throw new Error(`no PostgreSQL jar pinned for ${platform} (RELEASE in ${fileURLToPath(import.meta.url)})`);
  const name = `embedded-postgres-binaries-${jar.artifact}`;
  const url = `https://repo1.maven.org/maven2/io/zonky/test/postgres/${name}/${release.version}/${name}-${release.version}.jar`;
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== jar.sha256) throw new Error(`${name} has sha256 ${actual}, not the pinned ${jar.sha256}; refusing it`);

  const dir = mkdtempSync(join(tmpdir(), "sanoma-postgres-"));
  const archive = join(packageDir(platform), "postgres.tar.gz");
  try {
    // The jar is a zip of one `postgres-<os>-<arch>.txz`.
    writeFileSync(join(dir, "postgres.jar"), bytes);
    run(["unzip", "-q", "postgres.jar", "*.txz"], dir);
    const txz = readdirSync(dir).find((file) => file.endsWith(".txz"))!;
    const root = join(dir, "postgres");
    mkdirSync(root);
    run(["tar", "-xJf", join(dir, txz)], root);

    if (platform.startsWith("darwin-")) {
      // zonky's darwin binaries are universal (x86_64 and arm64): keep this package's half.
      forEachFile(root, (file) => {
        const thin = thinSlice(readFileSync(file), platform === "darwin-arm64" ? CPU_ARM64 : CPU_X86_64);
        if (thin) writeFileSync(file, thin);
      });
      linkDuplicates(join(root, "lib"));
    }
    if (platform.startsWith("win32-")) {
      // wxWidgets is for zonky's GUI tools, which the jar does not ship; the messages' translations are not needed.
      for (const file of readdirSync(join(root, "bin"))) {
        if (/^wx.*\.dll$/.test(file)) rmSync(join(root, "bin", file));
      }
      rmSync(join(root, "share", "locale"), { recursive: true, force: true });
    }

    // Written beside the archive, then renamed over it: a reader never sees half of one, nor
    // (postgres.json gone until the archive is in place) a manifest of another archive.
    // COPYFILE_DISABLE: macOS's tar would otherwise add `._` files for extended attributes.
    run(["tar", "-czf", `${archive}.tmp`, ...readdirSync(root)], root, { COPYFILE_DISABLE: "1" });
    const manifest = { postgres: release.version, sha256: sha256(readFileSync(`${archive}.tmp`)) };
    rmSync(join(packageDir(platform), "postgres.json"), { force: true });
    renameSync(`${archive}.tmp`, archive);
    writeFileSync(join(packageDir(platform), "postgres.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return archive;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${archive}.tmp`, { force: true });
  }
}

/**
 * Checks `platform`'s package as it is: its archive against `postgres.json`'s sha256, then
 * extracts it into a temporary directory and returns what `bin/postgres --version` prints.
 * Throws unless that names the version `postgres.json` does.
 */
export function checkPostgres(platform: string = `${process.platform}-${process.arch}`): string {
  const dir = packageDir(platform);
  const manifest = JSON.parse(readFileSync(join(dir, "postgres.json"), "utf8")) as { postgres: string; sha256: string };
  const archive = join(dir, "postgres.tar.gz");
  const actual = sha256(readFileSync(archive));
  if (actual !== manifest.sha256)
    throw new Error(`${archive} has sha256 ${actual}, not postgres.json's ${manifest.sha256}`);
  const root = mkdtempSync(join(tmpdir(), "sanoma-postgres-check-"));
  try {
    run(["tar", "-xzf", archive], root);
    const postgres = join(root, "bin", platform.startsWith("win32-") ? "postgres.exe" : "postgres");
    const result = spawnSync(postgres, ["--version"], { encoding: "utf8" });
    if (result.error) throw result.error;
    const version = result.stdout.trim();
    // zonky's 18.6.0 is PostgreSQL 18.6.
    const expected = `postgres (PostgreSQL) ${manifest.postgres.split(".").slice(0, 2).join(".")}`;
    if (result.status !== 0 || version !== expected) {
      throw new Error(
        `${postgres} --version printed "${version}"${result.stderr ? ` (${result.stderr.trim()})` : ""}, not "${expected}"`,
      );
    }
    return version;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Mach-O CPU types (`CPU_TYPE_ARM64`, `CPU_TYPE_X86_64`). */
export const CPU_ARM64 = 0x0100000c;
export const CPU_X86_64 = 0x01000007;

/**
 * The slice for `cpu` of a universal ("fat") Mach-O file, byte for byte what `lipo -thin` writes
 * (each slice carries its own code signature), or undefined when `file` is not one. In Node, so a
 * darwin package can be packed on Linux, where there is no `lipo`.
 */
export function thinSlice(file: Buffer, cpu: number): Buffer | undefined {
  if (file.length < 8) return undefined;
  const magic = file.readUInt32BE(0);
  const fat64 = magic === 0xcafebabf;
  if (magic !== 0xcafebabe && !fat64) return undefined;
  const count = file.readUInt32BE(4);
  // A Java class file shares the magic; its next word (a version) is far above any slice count.
  if (count === 0 || count > 16) return undefined;
  for (let i = 0; i < count; i++) {
    const at = 8 + i * (fat64 ? 32 : 20);
    if (file.readUInt32BE(at) !== cpu) continue;
    const offset = fat64 ? Number(file.readBigUInt64BE(at + 8)) : file.readUInt32BE(at + 8);
    const size = fat64 ? Number(file.readBigUInt64BE(at + 16)) : file.readUInt32BE(at + 12);
    if (offset + size > file.length) throw new Error(`a universal Mach-O file whose slice runs past its end`);
    return file.subarray(offset, offset + size);
  }
  throw new Error(`a universal Mach-O file without a slice for CPU type 0x${cpu.toString(16)}`);
}

/**
 * Replaces each regular file in `dir` (not below it) that is byte-identical to another with a
 * symlink to the one with the longest name. zonky's darwin jars store library aliases
 * (`libicuuc.77.dylib`, `libicuuc.dylib`) as full copies of the library (`libicuuc.77.1.dylib`);
 * the binaries load them by name, so each alias stays, as a link.
 */
export function linkDuplicates(dir: string): void {
  const byHash = new Map<string, string[]>();
  for (const name of readdirSync(dir)) {
    if (!lstatSync(join(dir, name)).isFile()) continue;
    const hash = sha256(readFileSync(join(dir, name)));
    byHash.set(hash, [...(byHash.get(hash) ?? []), name]);
  }
  for (const names of byHash.values()) {
    const [target, ...aliases] = names.toSorted((a, b) => b.length - a.length || a.localeCompare(b));
    for (const alias of aliases) {
      rmSync(join(dir, alias));
      symlinkSync(target!, join(dir, alias));
    }
  }
}

/** Calls `fn` with the path of each regular file under `dir`. */
function forEachFile(dir: string, fn: (file: string) => void) {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) fn(join(entry.parentPath, entry.name));
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Runs `command` in `cwd`; throws when it fails. */
function run([cmd, ...args]: string[], cwd: string, env?: Record<string, string>) {
  const result = spawnSync(cmd!, args, {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${[cmd, ...args].join(" ")} failed in ${cwd} (exit ${result.status})`);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { platform: { type: "string" }, check: { type: "boolean" } } });
  if (values.check) {
    console.log(checkPostgres(values.platform));
  } else {
    const archive = await downloadPostgres(values.platform);
    console.log(`wrote PostgreSQL ${RELEASE.version} to ${archive}`);
  }
}
