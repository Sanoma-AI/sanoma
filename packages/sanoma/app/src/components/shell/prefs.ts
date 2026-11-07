// The shell's preferences kept in cookies (the chat column's, and the density's for density.tsx),
// so the server renders them from the first paint: the root's loader reads them (`readPrefs` in
// routes/__root.tsx, which imports this module statically, so it stays this small) and the
// chrome writes them.

/** The cookie the chat column's state is kept in: `open` or `closed`, unset until Chat is used. */
export const CHAT_COOKIE = "sanoma_chat";

/**
 * The chat column as last left: open, folded, or, never set, `undefined`: open where it sits
 * beside the page (from `lg`), folded where it would lie over it.
 */
export type ChatPref = "open" | "closed" | undefined;

/** The cookie's value as a `ChatPref`: anything else is unset. */
export const chatPref = (value: string | undefined): ChatPref =>
  value === "open" || value === "closed" ? value : undefined;

/** The width from which the chat column sits beside the page rather than over it (Tailwind's `lg`). */
export const BESIDE_PAGE = "(min-width: 64rem)";

/** A year, in seconds. */
const MAX_AGE = 60 * 60 * 24 * 365;

/** Remembers a preference in its cookie for a year, for the next page the server renders. */
export function rememberPref(cookie: string, value: string) {
  document.cookie = `${cookie}=${value}; path=/; max-age=${MAX_AGE}`;
}
