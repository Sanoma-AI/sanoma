// A person's or a company's name as the pages shorten it, the same on the sign-in pages (server
// HTML) and in the app.

/** Two initials of a name: its first two words' first letters, or a single word's first two. */
export function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase();
}

/** A name's first word, as a sentence calls someone ("Opening it signs Sam in"). */
export const firstWordOf = (name: string): string => name.split(/\s+/).find(Boolean) ?? name;
