// The seam for what still needs the company's checkout in the app's own process: the chat turn,
// which runs a coding agent as a child process in a draft (what writes the repository, follows a
// host's webhook, tells how far an app is behind its source or checks a sandbox run is the
// worker's, in runs and the runtime's tables). The Node adapter's app imports this module; the
// Worker's bundle replaces it with `none.ts`, so none of it, or what it imports, is in the bundle,
// and each caller answers "not available on this host" (501, `notHere`) when `local` is undefined.
// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { postSignInCode } from "../agent/acp.ts";
import { postChat } from "../agent/turn.ts";

const actions = { postChat, postSignInCode };

/** What needs the checkout, as one object. */
export type Local = typeof actions;

/** The actions, here; undefined in the Worker's bundle (`none.ts`). */
export const local: Local | undefined = actions;
