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
const cleaned = ({ open, bounds: _bounds, ...company }: Company & { bounds?: unknown }): Company => ({
  ...company,
  ...(open === true && { open }),
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

/** A row of the start window's Recent list: the company, marked when it runs (or is starting) now. */
export type RecentCompany = Company & { running: boolean };

/** The Recent list, each company marked when it is among `running` (real paths). */
export const recentOf = (companies: readonly Company[], running: ReadonlySet<string>): RecentCompany[] =>
  companies.map((c) => ({ ...c, running: running.has(c.path) }));

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

/** The company's name: its `package.json`'s, else its folder's. */
export function companyName(path: string): string {
  try {
    const { name } = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { name?: unknown };
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
