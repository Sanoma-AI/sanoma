import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The variables that give git a user of its own and none of this machine's settings (signing,
 * hooks, a default branch), so a test commits the same anywhere. Set each with `set`, such as
 * vitest's `vi.stubEnv`, or spread them into a child's environment.
 */
export function gitIdentity(set?: (name: string, value: string) => void): Record<string, string> {
  const config = join(mkdtempSync(join(tmpdir(), "sanoma-git-")), "gitconfig");
  writeFileSync(config, "[user]\n\tname = Test User\n\temail = test@example.com\n");
  const env = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
  for (const [name, value] of Object.entries(env)) set?.(name, value);
  return env;
}
