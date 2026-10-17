import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ResourceProblem } from "./resources.ts";

// The lockfile: which vendor object each declaration means, kept apart from the data files (which
// hold intent only), as `package-lock.json` is from `package.json`. Only apply writes it.

/** Where the lockfile is, relative to the config's root. */
export const LOCKFILE = "resources/sanoma.lock.json";

/** Which vendor object a declaration means: its `<vendor>.<type>` and the vendor's stable id for it. */
export interface Binding {
  type: string;
  id: string;
}

/** The lockfile's content: by declaration key, `<file>#<export>` (the file relative to the config's root, with `/`). */
export type Bindings = Record<string, Binding>;

const lockfile = z.record(
  z.string().regex(/^resources\/[^#]+#[^#]+$/),
  z.strictObject({ type: z.string().regex(/^[^.\s]+\.[^.\s]+$/), id: z.string().min(1) }),
);

/**
 * The lockfile under `root`: no bindings when there is none, and no bindings with a problem when
 * it is not JSON or not a map of `<file>#<export>` to `{ type, id }`.
 */
export function readLockfile(root: string): { bindings: Bindings; problems: ResourceProblem[] } {
  const path = join(root, LOCKFILE);
  if (!existsSync(path)) return { bindings: {}, problems: [] };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { bindings: {}, problems: [{ file: LOCKFILE, message: `not JSON: ${(e as Error).message}` }] };
  }
  const parsed = lockfile.safeParse(json);
  if (!parsed.success) {
    // One line: zod's own spans lines.
    return {
      bindings: {},
      problems: [{ file: LOCKFILE, message: z.prettifyError(parsed.error).replaceAll(/\s*\n\s*/g, " ") }],
    };
  }
  return { bindings: parsed.data, problems: [] };
}

/** The lockfile's text for `bindings`: keys sorted, two-space JSON, a trailing newline, so a diff shows only what changed. */
export function serializeLockfile(bindings: Bindings): string {
  const sorted = Object.entries(bindings)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, { type, id }]) => [key, { type, id }]);
  return `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`;
}

/** Writes the lockfile under `root` whole or not at all: to a file beside it, then renamed over it. Apply only. */
export function writeLockfile(root: string, bindings: Bindings): void {
  const path = join(root, LOCKFILE);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, serializeLockfile(bindings));
    renameSync(temporary, path);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}

/**
 * One change to the lockfile: a declaration bound for the first time (`bind`, `to`), pointed at
 * another object (`rebind`, `from` and `to`), or no longer bound (`unbind`, `from`). `type` is
 * the binding's `<vendor>.<type>`, the new one's for a rebind.
 */
export interface Rebind {
  key: string;
  type: string;
  kind: "bind" | "rebind" | "unbind";
  from?: string;
  to?: string;
}

/** What changed from `before` to `after`, by key, sorted. */
export function diffLockfiles(before: Bindings, after: Bindings): Rebind[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted();
  return keys.flatMap((key): Rebind[] => {
    const was = before[key];
    const now = after[key];
    if (!now) return was ? [{ key, type: was.type, kind: "unbind", from: was.id }] : [];
    if (!was) return [{ key, type: now.type, kind: "bind", to: now.id }];
    if (was.id === now.id && was.type === now.type) return [];
    return [{ key, type: now.type, kind: "rebind", from: was.id, to: now.id }];
  });
}
