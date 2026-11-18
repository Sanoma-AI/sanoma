// A person's or a company's name as the pages show and shorten it, the same on the sign-in pages
// (server HTML) and in the app; and a company operation's.

import { OPERATIONS_VENDOR } from "sanoma/workflows/shared";

/** A company operation's name, as its page and the Connectors page show it: its id less `operations.` and `.run` (`quote`, `crm.score`). */
export const operationName = (id: string) => id.slice(OPERATIONS_VENDOR.length + 1, -".run".length);

/** Two initials of a name: its first two words' first letters, or a single word's first two. */
export function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase();
}

/** A name's first word, as a sentence calls someone ("Opening it signs Sam in"). */
export const firstWordOf = (name: string): string => name.split(/\s+/).find(Boolean) ?? name;

/** A company as a page names it: its name, and two initials for its mark. */
export interface Company {
  name: string;
  initials: string;
}

/** The company named `name` (`resolved.name`, already for people to read), with its initials. */
export function companyOf(name: string): Company {
  return { name, initials: initialsOf(name) };
}
