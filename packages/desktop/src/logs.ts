import { appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

/**
 * The userinfo of a URL with a password (`scheme://user:password@`), or of one with a token alone
 * (`scheme://token@host`): the password may hold a `/`, the user and the token may not.
 */
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)(?:[^\s"'@/:]*:[^\s"'@]*|[^\s"'@/:]+)@/gi;

/**
 * `text` with the user and password of each URL in it replaced by `***`: the launcher's
 * `database` event carries the cluster's URL with its password, and a pasted clone URL or an
 * error may carry a token.
 */
export const hidePasswords = (text: string) => text.replace(USERINFO, "$1***@");

/** How many lines `tail` keeps: what the start window shows when a company stops. */
export const TAIL_LINES = 200;

export interface CompanyLog {
  /** `<dir>/<slug>.log`. */
  file: string;
  /** Appends a line, timestamped and marked with where it came from, its URLs without passwords (`hidePasswords`). */
  write(from: string, line: string): void;
  /** The last `TAIL_LINES` lines written, as written. */
  tail(): string[];
  /** Ends this start's log: later lines (a process its launcher left, still printing) are dropped. */
  close(): void;
}

/** A company's log for one start: `<dir>/<slug>.log`, the previous one kept as `<slug>.1.log`. */
export function openLog(dir: string, slug: string): CompanyLog {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${slug}.log`);
  if (existsSync(file)) renameSync(file, join(dir, `${slug}.1.log`));
  const lines: string[] = [];
  let closed = false;
  return {
    file,
    write(from, line) {
      if (closed) return;
      // No password reaches the file or the start window: the `database` event's URL carries one.
      const text = `${new Date().toISOString()} ${from} ${hidePasswords(line)}`;
      lines.push(text);
      if (lines.length > TAIL_LINES) lines.shift();
      appendFileSync(file, `${text}\n`);
    },
    tail: () => [...lines],
    close: () => void (closed = true),
  };
}
