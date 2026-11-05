import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { COMPANY_MIGRATIONS, type MigrationsJournal, WAKEUP_MIGRATIONS } from "../src/db/migrate.ts";

// Drizzle's migrator applies a migration only when it is newer than the newest one a database has
// had, so a migration generated on a branch before another merged to `main` is skipped, silently,
// on every database already past it. CI runs this on a pull request against `origin/main`: every
// entry a journal gains must be newer than the base's newest, with the next index.

const pkg = fileURLToPath(new URL("..", import.meta.url));
const base = process.argv[2] ?? "origin/main";

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: pkg, stdio: ["ignore", "pipe", "pipe"] }).toString();

// The base must resolve: a check against a ref the checkout lacks would pass every journal.
try {
  git("rev-parse", "--verify", "--quiet", `${base}^{commit}`);
} catch {
  console.error(`${base} does not resolve: fetch it before the check`);
  process.exit(1);
}

/** The journal at `ref`, or undefined while the folder is not there. */
const journalAt = (ref: string, path: string): MigrationsJournal | undefined =>
  git("ls-tree", "--full-tree", "--name-only", ref, "--", path).trim()
    ? JSON.parse(git("show", `${ref}:${path}`))
    : undefined;

const problems: string[] = [];
for (const { name, journal: head } of [COMPANY_MIGRATIONS, WAKEUP_MIGRATIONS]) {
  const path = `packages/workflows/drizzle/${name}/meta/_journal.json`;
  const before = journalAt(base, path);
  if (!before) continue;
  const known = new Set(before.entries.map((e) => e.tag));
  const newest = Math.max(0, ...before.entries.map((e) => e.when));
  let idx = before.entries.length;
  for (const entry of head.entries) {
    if (known.has(entry.tag)) continue;
    if (entry.when <= newest)
      problems.push(
        `${path}: ${entry.tag} is older than the newest migration on ${base}, so a database past it would never get it: generate it again`,
      );
    if (entry.idx !== idx) problems.push(`${path}: ${entry.tag} has index ${entry.idx}, expected ${idx}`);
    idx++;
  }
  for (const entry of before.entries)
    if (!head.entries.some((e) => e.tag === entry.tag))
      problems.push(`${path}: ${entry.tag} was on ${base} and is gone`);
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`migration journals follow ${base}`);
