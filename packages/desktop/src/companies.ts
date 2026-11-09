import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { isCompanyFolder } from "./places.ts";

/** A company this shell has opened, as `companies.json` remembers it. */
export interface Company {
  /** The folder's real path. */
  path: string;
  name: string;
  /** The app's port, the same at every start, so its origin (and what the page keeps there) stays. */
  port: number;
  /** ISO time of the last open. */
  lastOpened: string;
  /**
   * Whether it is open: set when it starts, cleared when the person stops it (Company → Stop, or
   * a failed one's "Don't open it at launch"), and kept through Quit, so the next launch opens it
   * again (`toReopen`).
   */
  open?: boolean;
  /** Whether the person has read that its folder is a synced one (`syncedFolderWarning`), which is said once. */
  warned?: boolean;
}

/** The first port tried for a new company: clear of the launcher's own default, 3000. */
export const FIRST_PORT = 3100;

const isCompany = (value: unknown): value is Company => {
  const c = value as Company;
  return (
    typeof c === "object" &&
    c !== null &&
    typeof c.path === "string" &&
    typeof c.name === "string" &&
    Number.isInteger(c.port) &&
    typeof c.lastOpened === "string"
  );
};

/**
 * A company as read: what is not one of its fields' kind is dropped, not the company, as is the
 * window bounds each company had before the shell had one window (`Settings.bounds` now).
 */
const cleaned = ({ open, warned, bounds: _bounds, ...company }: Company & { bounds?: unknown }): Company => ({
  ...company,
  ...(open === true && { open }),
  ...(warned === true && { warned }),
});

/** The companies `file` remembers, most recently opened first; none when it is missing or unreadable. */
export function readCompanies(file: string): Company[] {
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? byRecent(parsed.filter(isCompany).map(cleaned)) : [];
  } catch {
    return [];
  }
}

/** Writes the list whole, through a temporary file, so a crash never leaves half of it. */
export function writeCompanies(file: string, companies: readonly Company[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(companies, null, 2)}\n`);
  renameSync(temporary, file);
}

const byRecent = (companies: Company[]) => companies.toSorted((a, b) => b.lastOpened.localeCompare(a.lastOpened));

/** The list with `company` in it, replacing the entry for its path, most recently opened first. */
export function remember(companies: readonly Company[], company: Company): Company[] {
  return byRecent([company, ...companies.filter((c) => c.path !== company.path)]);
}

/** The list with the entry for `path` changed by `patch`, in its place; unchanged without one. */
export const updated = (companies: readonly Company[], path: string, patch: Partial<Company>): Company[] =>
  companies.map((c) => (c.path === path ? { ...c, ...patch } : c));

/**
 * The list after a start at `path` failed: without it when its folder holds no company (a clone or
 * a new company's init that failed), so Recent never lists what cannot be opened.
 */
export const afterFailure = (
  companies: readonly Company[],
  path: string,
  holdsCompany: (dir: string) => boolean = isCompanyFolder,
): Company[] => (holdsCompany(path) ? [...companies] : companies.filter((c) => c.path !== path));

/** The folders to open at launch: the companies open when the shell last stopped, whose folders still hold one. */
export const toReopen = (
  companies: readonly Company[],
  holdsCompany: (dir: string) => boolean = isCompanyFolder,
): string[] => companies.filter((c) => c.open && holdsCompany(c.path)).map((c) => c.path);

/**
 * Whether a company is live, as its folder says: once its lockfile binds the host its data file
 * declares (`resources/sanoma/infra.ts#host`), this folder is a drafting copy of it, which runs
 * at the host's `hostname` when the data file names one. Undefined while it is local.
 */
export type Live = { hostname?: string } | undefined;

/** The lockfile's key for the company's host. */
const HOST_KEY = "resources/sanoma/infra.ts#host";
/** The `hostname` a `.host({ … })` declaration names, read as text: the data file is code the shell never runs. */
const HOSTNAME = /\.host\(\s*\{[^)]*?\bhostname\s*:\s*["'`]([^"'`\s]+)["'`]/;

/** What `file` holds, or undefined when it cannot be read. */
const textOf = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/** Whether the company at `path` is live (`Live`): whatever cannot be read leaves it local. */
export function liveOf(path: string): Live {
  try {
    const lock = JSON.parse(textOf(join(path, "resources", "sanoma.lock.json")) ?? "{}") as object;
    if (!(HOST_KEY in lock)) return undefined;
  } catch {
    // A lockfile that is not JSON binds nothing.
    return undefined;
  }
  const hostname = HOSTNAME.exec(textOf(join(path, "resources", "sanoma", "infra.ts")) ?? "")?.[1];
  return hostname ? { hostname } : {};
}

/** A row of the start window's Recent list: the company, marked when it runs (or is starting) now, and when it is live. */
export type RecentCompany = Company & { running: boolean; live: Live };

/** The Recent list, each company marked when it is among `running` (real paths), and when it is live (`liveOf`). */
export const recentOf = (
  companies: readonly Company[],
  running: ReadonlySet<string>,
  live: (path: string) => Live = liveOf,
): RecentCompany[] => companies.map((c) => ({ ...c, running: running.has(c.path), live: live(c.path) }));

/** Whether nothing listens on `port` on this machine's loopback address. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/**
 * The port for the company at `path`: the one remembered for it while it is free, else the first
 * free one from `FIRST_PORT` that no other remembered company has. `moved` says the remembered
 * one was taken: the app's origin changes, and the page asks who you are again.
 */
export async function portFor(
  companies: readonly Company[],
  path: string,
  isFree: (port: number) => Promise<boolean> = isPortFree,
): Promise<{ port: number; moved: boolean }> {
  const remembered = companies.find((c) => c.path === path)?.port;
  if (remembered !== undefined && (await isFree(remembered))) return { port: remembered, moved: false };
  const others = new Set(companies.filter((c) => c.path !== path).map((c) => c.port));
  for (let port = FIRST_PORT; port < 65_536; port++) {
    if (port !== remembered && !others.has(port) && (await isFree(port))) {
      return { port, moved: remembered !== undefined };
    }
  }
  throw new Error("no free port on this machine");
}

/**
 * The `name` that `sanoma.config.ts` gives `defineConfig`, read as text: a top-level key, so the
 * first `name: "…"` after `defineConfig({` that is first in the braces or on a line of its own one
 * level in.
 */
const CONFIG_NAME = /defineConfig\(\s*\{(?:\s*|[\s\S]*?\n[ \t]{1,2})name\s*:\s*("(?:[^"\\\n]|\\.)*")/;

/** The name `sanoma.config.ts` at `path` gives the company, if it gives one. */
function configName(path: string): string | undefined {
  const literal = CONFIG_NAME.exec(textOf(join(path, "sanoma.config.ts")) ?? "")?.[1];
  try {
    return (literal && (JSON.parse(literal) as string)) || undefined;
  } catch {
    return undefined;
  }
}

/** The company's name: the one its `sanoma.config.ts` gives it, else its `package.json`'s, else its folder's. */
export function companyName(path: string): string {
  const named = configName(path);
  if (named) return named;
  try {
    const { name } = JSON.parse(textOf(join(path, "package.json")) ?? "{}") as { name?: unknown };
    if (typeof name === "string" && name) return name;
  } catch {
    // No readable package.json: the folder names it.
  }
  return basename(path);
}

const hashOf = (path: string) => createHash("sha1").update(path).digest("hex");

/** The window's storage, one per company folder, kept across starts: cookies, and who you are. */
export const partitionOf = (path: string) => `persist:company-${hashOf(path)}`;

/** The company's log name: its folder's name as one word, and a short hash, as two folders may share a name. */
export const slugOf = (path: string) =>
  `${
    basename(path)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "company"
  }-${hashOf(path).slice(0, 6)}`;
