import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MigrationsJournal } from "../packages/workflows/src/db/migrate.ts";

// Drizzle's migrator applies a migration only when it is newer than the newest one a database has
// had, so a migration generated on a branch before another merged to `main` is skipped, silently,
// on every database already past it. CI runs this on a pull request against `origin/main`, over
// every migrations folder in the repository (`drizzle/<folder>/meta/_journal.json`, wherever git
// tracks one): every entry a journal gains must be newer than the base's newest, with the next index.

const repo = fileURLToPath(new URL("..", import.meta.url));
const base = process.argv[2] ?? "origin/main";

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).toString();

// The base must resolve: a check against a ref the checkout lacks would pass every journal.
try {
  git("rev-parse", "--verify", "--quiet", `${base}^{commit}`);
} catch {
  console.error(`${base} does not resolve: fetch it before the check`);
  process.exit(1);
}

/** Where a migrations folder keeps its journal, wherever the folder is. */
const JOURNAL = /(^|\/)drizzle\/[^/]+\/meta\/_journal\.json$/;

/** The journals `ref` tracks (the working tree's for HEAD), by path; `ls-tree` takes no glob, so every path is listed and matched. */
const journalsOf = (ref: string): string[] =>
  (ref === "HEAD" ? git("ls-files") : git("ls-tree", "-r", "--name-only", ref))
    .split("\n")
    .filter((path) => JOURNAL.test(path));

const journals = journalsOf("HEAD");
if (journals.length === 0) {
  console.error("no migration journal is tracked: the check would pass nothing");
  process.exit(1);
}

const problems: string[] = [];
const atBase = new Set(journalsOf(base));
// A folder renamed or deleted: every database past its migrations would start them over under the new name.
for (const path of atBase) if (!journals.includes(path)) problems.push(`${path}: a journal on ${base}, and gone`);
for (const path of journals) {
  if (!atBase.has(path)) continue;
  const head: MigrationsJournal = JSON.parse(readFileSync(join(repo, path), "utf8"));
  const before: MigrationsJournal = JSON.parse(git("show", `${base}:${path}`));
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
console.log(`${journals.length} migration journals follow ${base}`);
