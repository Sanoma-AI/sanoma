import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** `value` as one word for `sh`, in single quotes. */
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** `value` as one word in a `.cmd` file: in double quotes (no Windows path has one), its `%` doubled. */
const quoteCmd = (value: string) => `"${value.replaceAll("%", "%%")}"`;

/**
 * The scripts first on the launcher's PATH, so that what it and the company's own scripts run as
 * `node` and `pnpm` is the Node this shell ships and the pnpm it stages, whatever the computer has.
 * On Windows only `pnpm.cmd`: a program that runs `node` without a shell finds an `.exe` and never
 * a `.cmd`, so there the Node's own folder goes on PATH instead (`writeShims`).
 */
export function shims(
  node: string,
  pnpm: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (platform === "win32") {
    // cmd reads a batch file in the console's code page: UTF-8 first, for a path such as C:\Users\José.
    return { "pnpm.cmd": `@echo off\r\nchcp 65001 >nul 2>&1\r\n${quoteCmd(node)} ${quoteCmd(pnpm)} %*\r\n` };
  }
  return {
    node: `#!/bin/sh\nexec ${quote(node)} "$@"\n`,
    pnpm: `#!/bin/sh\nexec ${quote(node)} ${quote(pnpm)} "$@"\n`,
  };
}

/**
 * Writes `shims` into `dir`, executable, at every start (the shell's own paths move when it is
 * updated or moved): each through a temporary file and a rename, as another company's scripts may
 * be running one, and only when it changed. Returns the folders to put first on PATH: `dir`, and on
 * Windows the Node's own folder after it.
 */
export function writeShims(
  dir: string,
  node: string,
  pnpm: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(shims(node, pnpm, platform))) {
    const file = join(dir, name);
    if (existsSync(file) && readFileSync(file, "utf8") === text) continue;
    writeFileSync(`${file}.tmp`, text, { mode: 0o755 });
    renameSync(`${file}.tmp`, file);
  }
  return platform === "win32" ? [dir, dirname(node)] : [dir];
}
