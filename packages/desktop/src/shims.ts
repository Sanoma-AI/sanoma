import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `value` as one word for `sh`, in single quotes. */
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The scripts first on the launcher's PATH, so that what it and the company's own scripts run as
 * `node` and `pnpm` is the Node this shell ships and the pnpm it stages, whatever the computer has.
 */
export function shims(node: string, pnpm: string): Record<"node" | "pnpm", string> {
  return {
    node: `#!/bin/sh\nexec ${quote(node)} "$@"\n`,
    pnpm: `#!/bin/sh\nexec ${quote(node)} ${quote(pnpm)} "$@"\n`,
  };
}

/** Writes `shims` into `dir`, executable, every time: the shell's own paths move when it is updated or moved. */
export function writeShims(dir: string, node: string, pnpm: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(shims(node, pnpm))) {
    writeFileSync(join(dir, name), text);
    chmodSync(join(dir, name), 0o755);
  }
}
