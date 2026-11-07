import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/** The importing test file's temporary directory, removed after its tests. */
const dir = mkdtempSync(join(tmpdir(), "sanoma-tree-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A directory `name` under the file's temporary one, made with `files` (relative path to text) in it. */
export function tree(name: string, files: Record<string, string> = {}): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

/** A config root whose `package.json` names the app `name`, and holds nothing else. */
export const appRoot = (name: string): string => tree(name, { "package.json": JSON.stringify({ name }) });
