// A person's or a company's name as the pages show and shorten it, the same on the sign-in pages
// (server HTML) and in the app.

/** Two initials of a name: its first two words' first letters, or a single word's first two. */
export function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase();
}

/** A name's first word, as a sentence calls someone ("Opening it signs Sam in"). */
export const firstWordOf = (name: string): string => name.split(/\s+/).find(Boolean) ?? name;

/** A company as a page names it: its app's name humanised, and two initials for its mark. */
export interface Company {
  name: string;
  initials: string;
}

/**
 * The company an app's name (`package.json`'s, `resolved.appName`) is, for people to read: its
 * scope dropped, `-` and `_` as spaces, each word capitalised (`sanoma-ops` is "Sanoma Ops", "SO").
 */
export function companyOf(appName: string): Company {
  const words = appName
    .replace(/^@[^/]*\//, "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1));
  const name = words.join(" ") || "Sanoma";
  return { name, initials: initialsOf(name) };
}
