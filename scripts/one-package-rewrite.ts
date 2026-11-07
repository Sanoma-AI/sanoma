/// <reference lib="es2025.regexp" />
/**
 * sanoma#686's rewrite, for a branch that merges main after the core became the one `sanoma` package:
 * `node scripts/one-package-rewrite.ts` from the repository's root, then `pnpm install`. Running it
 * again changes nothing.
 *
 * - A file still under an old package directory (one the branch added) moves to its new one.
 * - A relative path (a quoted string or a word of a script; in Markdown, a link's target) that reached a moved file,
 *   or that a moved file used to reach something, points there from where the file is now.
 * - Each `package.json` that depended on a folded package depends on `sanoma` in its place, in the same
 *   field (`workspace:*` in this workspace).
 * - pnpm's overrides of folded packages (`pnpm-workspace.yaml`'s `overrides`, a `package.json`'s
 *   `pnpm.overrides` or `overrides`) become one of `sanoma`, with the first one's value.
 * - Every other mention of an old package's name or directory takes the new one: import specifiers
 *   (static, dynamic, `vi.mock`, strings, escaped in a regular expression), `pnpm --filter`, docs.
 *
 * What it cannot decide it prints: an old package's `package.json` left in place (its fields merge into
 * `packages/sanoma/package.json` by hand), a `--filter` excluding a folded package, and mentions of
 * `@sanoma-ai/dev`, `sanoma-dev` and `sanoma-tfschema`, which became `sanoma dev` and `sanoma tfschema`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";

/** Each folded package's directory, before and after. */
const MOVES: readonly (readonly [from: string, to: string])[] = [
  ["packages/workflows", "packages/sanoma/workflows"],
  ["packages/app", "packages/sanoma/app"],
  ["packages/bridge", "packages/sanoma/bridge"],
  ["packages/testing", "packages/sanoma/testing"],
  ["packages/dev", "packages/sanoma/dev"],
  ["connectors/better-auth", "packages/sanoma/better-auth"],
];

/**
 * Each folded package's name, and the specifier that replaces it (`@sanoma-ai/dev` has none: it is
 * `sanoma dev`). The app's site surface and the runtime's data-file entries already had their
 * `sanoma/*` names: a subpath before its package.
 */
const NAMES: readonly (readonly [from: string, to: string])[] = [
  ["@sanoma-ai/app/site", "sanoma/site"],
  ["@sanoma-ai/app/ui.css", "sanoma/ui.css"],
  ["@sanoma-ai/app/ui", "sanoma/ui"],
  ["@sanoma-ai/workflows/resources", "sanoma/resources"],
  ["@sanoma-ai/workflows/data", "sanoma/data"],
  ["@sanoma-ai/workflows/kms-secrets", "sanoma/secrets"],
  ["@sanoma-ai/workflows", "sanoma/workflows"],
  ["@sanoma-ai/app", "sanoma/app"],
  ["@sanoma-ai/testing", "sanoma/testing"],
  ["@sanoma-ai/bridge", "sanoma/internal/bridge"],
  ["@sanoma-ai/connector-better-auth", "sanoma/better-auth"],
];

const FOLDED = new Set([...NAMES.map(([from]) => from), "@sanoma-ai/dev"]);
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const TEXT = /\.(c|m)?[jt]sx?$|\.jsonc?$|\.md$|\.ya?ml$|\.css$|\.sh$|(^|\/)Dockerfile$/;
// Left as they are: the lockfile, test data, this script, and the binaries' manifests, which name
// `@sanoma-ai/bridge` as npm has them, unchanged until the binary is.
const SKIP =
  /(^|\/)(pnpm-lock\.yaml|testdata\/.*(?<!\.md))$|^scripts\/one-package-rewrite\.ts$|^packages\/bridge-bin\/[^/]+\/package\.json$/;

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });
const warnings: string[] = [];

/** `path` (repo-relative, `/`-separated) where the moves put it. */
function moved(path: string): string {
  for (const [from, to] of MOVES) if (path === from || path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return path;
}

/** Where the file now at `path` was before the moves. */
function original(path: string): string {
  for (const [from, to] of MOVES) if (path === to || path.startsWith(`${to}/`)) return from + path.slice(to.length);
  return path;
}

const exists = (path: string) => existsSync(path === "" ? "." : path);

/** A file the branch left under an old directory, moved to the new one (never over a file there). */
function moveLeftovers(): void {
  for (const [from] of MOVES) {
    for (const file of git("ls-files", "--", from).split("\n").filter(Boolean)) {
      const to = moved(file);
      if (file === `${from}/package.json`) {
        warnings.push(`${file}: merge what it adds into packages/sanoma/package.json, then delete it`);
      } else if (exists(to)) {
        warnings.push(`${file}: ${to} exists already; merge the two by hand`);
      } else {
        mkdirSync(dirname(to), { recursive: true });
        git("mv", file, to);
        console.log(`moved ${file} -> ${to}`);
      }
    }
  }
}

/**
 * A relative path in the file at `file` that no longer reaches anything, pointed at where its target
 * went: read from where the file was, its target moved. Unchanged when it reaches something already,
 * or nothing either way (a glob, a path made up at run time).
 */
function rebase(spec: string, file: string, markdown = false): string {
  const cut = spec.search(/[?#]/);
  const [path, suffix] = cut < 0 ? [spec, ""] : [spec.slice(0, cut), spec.slice(cut)];
  if (!/^(\.\.?\/)+[^./]/.test(path) || /[*${}]/.test(path)) return spec;
  const here = posix.dirname(file);
  if (exists(posix.normalize(posix.join(here, path)))) return spec;
  const target = moved(posix.normalize(posix.join(posix.dirname(original(file)), path)));
  if (target.startsWith("../") || !exists(target)) return spec;
  let next = posix.relative(here, target) || ".";
  // An import specifier must start with a dot; a Markdown link need not.
  if (!next.startsWith("../") && !markdown) next = `./${next}`;
  if (path.endsWith("/") && !next.endsWith("/")) next += "/";
  return next + suffix;
}

/** Every mention of a folded package's name or directory, in `text`, the new one. */
function renamed(text: string): string {
  // An npm page of a folded package: its README, in the repository.
  let out = text.replace(
    /https:\/\/www\.npmjs\.com\/package\/@sanoma-ai\/(workflows|app|bridge|testing|dev|connector-better-auth)(?![\w/-])/g,
    (_, name: string) =>
      `https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/${name.replace("connector-", "")}/README.md`,
  );
  out = out.replace(
    new RegExp(`(--filter[= ]+)(["']?)(${[...FOLDED].map(RegExp.escape).join("|")})\\2(?![\\w/-])`, "g"),
    "$1$2sanoma$2",
  );
  for (const [from, to] of NAMES) {
    // Plain, or escaped as in a regular expression's source (`@sanoma-ai\/app`).
    const name = from.split("/").map(RegExp.escape).join("(\\\\?/)");
    out = out.replace(new RegExp(`${name}(?![\\w-])`, "g"), (_, slash: string) => to.split("/").join(slash));
  }
  for (const [from, to] of MOVES) {
    out = out.replace(new RegExp(`(?<![\\w.-])${RegExp.escape(from)}(?![\\w-])`, "g"), to);
  }
  return out;
}

/**
 * An override's selector (`name`, `name@range`, `parent>name`) with each folded package in it (or the
 * `sanoma/<part>` an earlier run of this script made of one) as `sanoma`, its range dropped: a
 * folded package's versions are not sanoma's.
 */
function overrideKey(key: string): string {
  return key
    .split(">")
    .map((selector) => {
      const at = selector.indexOf("@", 1);
      const name = at < 0 ? selector : selector.slice(0, at);
      return FOLDED.has(name) || name.startsWith("sanoma/") ? "sanoma" : selector;
    })
    .join(">");
}

/**
 * Overrides (`[key, value]` in order) with each folded package's collapsed into one of `sanoma`, the
 * first one's value; undefined when none names one. Says when that value needs a look.
 */
function collapseOverrides(entries: [string, string][], file: string): [string, string][] | undefined {
  if (entries.every(([key]) => overrideKey(key) === key)) return undefined;
  const out = new Map<string, string>();
  for (const [key, value] of entries) {
    const next = overrideKey(key);
    if (out.has(next)) {
      if (out.get(next) !== value) warnings.push(`${file}: dropped the override ${key}: ${value}, now ${next}'s`);
      continue;
    }
    out.set(next, value);
    if (next !== key && !/^(workspace|link):/.test(value)) {
      warnings.push(`${file}: the override of ${next} is ${key}'s, ${value}: check it fits sanoma`);
    }
  }
  return [...out];
}

/** A `pnpm-workspace.yaml`'s `overrides` with each folded package's collapsed (`collapseOverrides`). */
function yamlOverrides(text: string, file: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^overrides:\s*(#.*)?$/.test(line));
  if (start < 0) return text;
  let end = start + 1;
  while (end < lines.length && /^(\s|#|$)/.test(lines[end]!)) end++;
  const ENTRY = /^(\s+)(["']?)(.+?)\2:\s*(.*)$/;
  const block = lines.slice(start + 1, end);
  const entries = block.flatMap((line) => {
    const m = ENTRY.exec(line);
    return m ? [[m[3]!, m[4]!] as [string, string]] : [];
  });
  const kept = collapseOverrides(entries, file);
  if (!kept) return text;
  const values = new Map(kept);
  const rewritten = block.flatMap((line) => {
    const m = ENTRY.exec(line);
    if (!m) return [line];
    const key = overrideKey(m[3]!);
    if (!values.has(key)) return [];
    const value = values.get(key)!;
    values.delete(key);
    return [`${m[1]}${key === m[3] ? m[2] + key + m[2] : key}: ${value}`];
  });
  return [...lines.slice(0, start + 1), ...rewritten, ...lines.slice(end)].join("\n");
}

/**
 * A `package.json`'s text with each folded package among its dependencies replaced by `sanoma`, and
 * its overrides of them collapsed (`collapseOverrides`).
 */
function dependencies(text: string, file: string): string {
  const manifest = JSON.parse(text) as Record<string, unknown> & { name?: string };
  let changed = false;
  for (const field of DEP_FIELDS) {
    const deps = manifest[field] as Record<string, string> | undefined;
    if (!deps) continue;
    const removed = Object.keys(deps).filter((name) => FOLDED.has(name));
    if (!removed.length) continue;
    const spec = deps[removed[0]!]!;
    for (const name of removed) delete deps[name];
    const meta = manifest.peerDependenciesMeta as Record<string, unknown> | undefined;
    if (field === "peerDependencies" && meta) for (const name of removed) delete meta[name];
    if (manifest.name !== "sanoma" && deps.sanoma === undefined) {
      deps.sanoma = spec.startsWith("workspace:") ? "workspace:*" : "latest";
      if (!spec.startsWith("workspace:")) warnings.push(`${manifest.name}: ${field}.sanoma is "latest"; pin it`);
    }
    manifest[field] = Object.fromEntries(Object.entries(deps).toSorted(([a], [b]) => a.localeCompare(b)));
    changed = true;
  }
  for (const holder of [manifest, manifest.pnpm as Record<string, unknown> | undefined]) {
    const overrides = holder?.overrides as Record<string, string> | undefined;
    const kept = overrides && collapseOverrides(Object.entries(overrides), file);
    if (!kept) continue;
    holder!.overrides = Object.fromEntries(kept);
    changed = true;
  }
  return changed ? `${JSON.stringify(manifest, null, 2)}\n` : text;
}

function rewrite(file: string): void {
  const before = readFileSync(file, "utf8");
  let text = before;
  if (posix.basename(file) === "package.json") text = dependencies(text, file);
  if (posix.basename(file) === "pnpm-workspace.yaml") text = yamlOverrides(text, file);
  // A relative path wherever one starts in code (a quoted string, a word of a script); in Markdown,
  // a link's target only, as a path in its prose may be relative to anything.
  const markdown = file.endsWith(".md");
  text = text.replace(
    markdown ? /(\]\()(\.\.?\/[^\s)]*)/g : /(^|[\s"'`(=])((?:\.\.?\/)[^\s"'`(),;]*)/gm,
    (_, lead: string, spec: string) => lead + rebase(spec, file, markdown),
  );
  if (/--filter[= ]+["']?!@sanoma-ai\/(workflows|app|bridge|testing|dev|connector-better-auth)(?![\w-])/.test(text)) {
    warnings.push(`${file}: a --filter excludes a folded package: drop it, or exclude sanoma`);
  }
  text = renamed(text);
  for (const [pattern, says] of [
    [/@sanoma-ai\/dev(?![\w-])/, "@sanoma-ai/dev, now `sanoma dev`"],
    [/\bsanoma-dev\b(?![-.])/, "sanoma-dev, now `sanoma dev`"],
    [/\bsanoma-tfschema\b/, "sanoma-tfschema, now `sanoma tfschema`"],
  ] as const) {
    if (pattern.test(text)) warnings.push(`${file}: mentions ${says}`);
  }
  if (text === before) return;
  writeFileSync(file, text);
  console.log(`rewrote ${file}`);
}

moveLeftovers();
const files = git("ls-files", "--cached", "--others", "--exclude-standard")
  .split("\n")
  .filter((file) => file && TEXT.test(file) && !SKIP.test(file) && exists(file) && statSync(file).size < 4 << 20);
// The old packages' own manifests are merged by hand (`moveLeftovers` says which).
const manifests = new Set(MOVES.flatMap((move) => move.map((dir) => `${dir}/package.json`)));
for (const file of files) if (!manifests.has(file)) rewrite(file);
for (const line of warnings) console.error(`check: ${line}`);
