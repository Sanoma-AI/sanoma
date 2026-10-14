// The cookie a workflow page's rail keeps its fold in. Apart from the rail, since the root's loader
// reads it: importing it from the rail would put the rail in the root's bundle.

/** The cookie the rail's fold is kept in: `collapsed` or `open` (and, never set, open). */
export const RAIL_COOKIE = "sanoma_rail";
