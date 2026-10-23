// The shell's state kept in a cookie, so the server renders it from the first paint: the root's
// loader reads it (`readPrefs` in routes/__root.tsx, which imports this module statically, so it
// stays this small) and the chrome writes it.

/** The cookie the chat column's state is kept in: `open` or `closed` (and, never set, open). */
export const CHAT_COOKIE = "sanoma_chat";

/** A year, in seconds. */
const MAX_AGE = 60 * 60 * 24 * 365;

/** Remembers whether the chat column is open, for the next page the server renders. */
export function rememberChat(open: boolean) {
  document.cookie = `${CHAT_COOKIE}=${open ? "open" : "closed"}; path=/; max-age=${MAX_AGE}`;
}
