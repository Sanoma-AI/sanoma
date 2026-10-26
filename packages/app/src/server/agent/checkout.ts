import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Chat, Draft, Source } from "@sanoma-ai/workflows";
import type { AppContext } from "../../context.ts";

/** Where an agent may never write in a checkout: git's own files, and the install (`node_modules`, a link to the live one in a draft). */
const OFF_LIMITS = new Set([".git", "node_modules"]);

/**
 * The checkout rule: the absolute path `path` (relative to `worktree`, or absolute) names, when an
 * agent may read or write it there; undefined when it may not. Its parent's real path, the nearest
 * directory that exists followed by the rest (and the file's own, when it is a link), must lie
 * under the worktree's real path (the worktree itself is allowed, for a listing), and its first
 * segment there may not be `.git` or `node_modules` (a draft's `node_modules` is a link into the
 * live install). One rule for every engine: our loop's tools, `HarnessAgent`'s permission requests
 * and an ACP agent's.
 */
export async function allowedPath(worktree: string, path: string): Promise<string | undefined> {
  const root = await realpath(worktree);
  const wanted = resolve(root, path);
  const parent = await realParent(dirname(wanted));
  let full: string | undefined = join(parent, basename(wanted));
  // A link is followed to what it names, which must be inside too; a broken one names nothing.
  if ((await lstat(full).catch(() => undefined))?.isSymbolicLink()) full = await realpath(full).catch(() => undefined);
  if (full === undefined) return undefined;
  const inside = relative(root, full);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
  // Lower-cased: on a case-insensitive file system (macOS's default) `.GIT` is `.git`.
  return OFF_LIMITS.has(inside.split(sep)[0]!.toLowerCase()) ? undefined : full;
}

/** A repository a chat can draft in. */
export type Drafting = Source & Required<Pick<Source, "draft" | "diff">>;

/** The instance's repository, as every engine drafts in it; an error when it has none to draft in. */
export function drafting(app: AppContext): Drafting {
  const repo = app.source;
  if (!repo?.draft || !repo.diff) throw new Error("This instance has no repository to draft a change in");
  return repo as Drafting;
}

/** The chat's draft, opened (or found open), and attached to the chat's row the first time. */
export async function openDraft(app: AppContext, chat: Chat): Promise<Draft> {
  const opened = await drafting(app).draft(chat.id);
  if (chat.draftId !== chat.id) {
    await app.client.chats.attach(chat.id, chat.id);
    chat.draftId = chat.id;
  }
  return opened;
}

/** The real path of `dir`: of its nearest ancestor that exists, with the rest joined on. */
async function realParent(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    const up = dirname(dir);
    return up === dir ? dir : join(await realParent(up), basename(dir));
  }
}
