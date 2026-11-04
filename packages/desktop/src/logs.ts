import { appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { isEventLine } from "./events.ts";

/**
 * The userinfo of a URL, `scheme://user:password@` or `scheme://token@`: up to the first `/`, as
 * a URL's userinfo has no `/` unencoded (so `http://localhost:5173/@fs/…` keeps its host).
 */
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s"'@/]+@/gi;

/**
 * `text` with the user and password of each URL in it replaced by `***`: the launcher's
 * `database` event carries the cluster's URL with its password, and a pasted clone URL or an
 * error may carry a token.
 */
export const hidePasswords = (text: string) => text.replace(USERINFO, "$1***@");

/** How many lines `tail` keeps: what a company's page shows when it opens on a start under way, or one that stopped. */
export const TAIL_LINES = 200;

/** What a company's page shows of a start's log, so that its terminal writes only what is new. */
export interface LogTail {
  /** Which start this is: a different one clears the terminal. */
  start: number;
  /** How many lines came before `lines`. */
  skipped: number;
  /** As the process printed them, colours included, but for the passwords in their URLs. */
  lines: string[];
}

/** The tail of no log: before a start has one. */
export const NO_TAIL: LogTail = { start: 0, skipped: 0, lines: [] };

let starts = 0;

export interface CompanyLog {
  /** `<dir>/<slug>.log`. */
  file: string;
  /**
   * Appends a line to the file, timestamped and marked with where it came from, without escape
   * codes, and but for the launcher's event lines to the tail; its URLs without passwords in both
   * (`hidePasswords`).
   */
  write(from: string, line: string): void;
  /** Appends a line to the file alone: what the page says in its own words already. */
  note(from: string, line: string): void;
  /** The last `TAIL_LINES` lines for the page. */
  tail(): LogTail;
  /** Ends this start's log: later lines (a process its launcher left, still printing) are dropped. */
  close(): void;
}

/** A company's log for one start: `<dir>/<slug>.log`, the previous one kept as `<slug>.1.log`. */
export function openLog(dir: string, slug: string): CompanyLog {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${slug}.log`);
  if (existsSync(file)) renameSync(file, join(dir, `${slug}.1.log`));
  const start = ++starts;
  const lines: string[] = [];
  let skipped = 0;
  let closed = false;
  const toFile = (from: string, line: string) => appendFileSync(file, `${new Date().toISOString()} ${from} ${line}\n`);
  return {
    file,
    write(from, line) {
      if (closed) return;
      // No password reaches the file or the page: the `database` event's URL carries one. Looked for
      // without escape codes, which can split a URL, and with them, as a hyperlink's URL is one; a
      // line with one hidden loses its colours.
      const plain = stripVTControlCharacters(line);
      const hidden = hidePasswords(plain);
      toFile(from, hidden);
      if (isEventLine(line)) return;
      lines.push(hidden === plain && hidePasswords(line) === line ? line : hidden);
      if (lines.length > TAIL_LINES) {
        lines.shift();
        skipped++;
      }
    },
    note(from, line) {
      if (!closed) toFile(from, hidePasswords(stripVTControlCharacters(line)));
    },
    tail: () => ({ start, skipped, lines: [...lines] }),
    close: () => void (closed = true),
  };
}

/** What Copy puts on the clipboard: what the page says, then the tail without its colours. */
export const detailsOf = (said: readonly string[], { lines }: LogTail) =>
  [...said, "", ...lines.map((line) => stripVTControlCharacters(line))].join("\n");
