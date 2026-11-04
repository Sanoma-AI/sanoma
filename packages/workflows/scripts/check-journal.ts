import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Drizzle's migrator applies a migration only when it is newer than the newest one a database has
// had, so a migration generated on a branch before another merged to `main` is skipped, silently,
// on every database already past it. CI runs this on a pull request against `origin/main`: every
// entry a journal gains must be newer than the base's newest, with the next index.

const pkg = fileURLToPath(new URL("..", import.meta.url));
const base = process.argv[2] ?? "origin/main";

interface Journal {
  entries: { idx: number; when: number; tag: string }[];
}

const journalAt = (ref: string, path: string): Journal | undefined => {
  try {
    return JSON.parse(
      execFileSync("git", ["show", `${ref}:${path}`], { cwd: pkg, stdio: ["ignore", "pipe", "ignore"] }).toString(),
    );
  } catch {
    return undefined;
  }
};

const problems: string[] = [];
for (const folder of ["company", "wakeup"]) {
  const path = `packages/workflows/drizzle/${folder}/meta/_journal.json`;
  const head: Journal = JSON.parse(
    readFileSync(new URL(`../drizzle/${folder}/meta/_journal.json`, import.meta.url), "utf8"),
  );
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
