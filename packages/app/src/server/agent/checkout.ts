import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Chat, type Draft, errorCode, type Principal, type SanomaClient, type Source } from "@sanoma-ai/workflows";
import type { UIMessageStreamWriter } from "ai";
import type { AppContext } from "../../context.ts";
import { type ChatMessage, textOf } from "../../lib/chat.ts";
import { checks } from "../drafts.ts";
import type { EngineTurn } from "./transcript.ts";

/** Where an agent may never write in a checkout: git's own files, and the install (`node_modules`, a link to the live one in a draft). */
const OFF_LIMITS = new Set([".git", "node_modules"]);

/**
 * The checkout rule: the absolute path `path` (relative to `worktree`, or absolute) names, when an
 * agent may read or write it there; undefined when it may not. Its real path must lie under the
 * worktree's (`realWithin`; the worktree itself is allowed, for a listing), and its first segment
 * there may not be `.git` or `node_modules` (a draft's `node_modules` is a link into the live
 * install). One rule for every engine: our loop's tools, `HarnessAgent`'s permission requests and
 * an ACP agent's.
 */
export async function allowedPath(worktree: string, path: string): Promise<string | undefined> {
  const real = await realWithin(worktree, path);
  // Lower-cased: on a case-insensitive file system (macOS's default) `.GIT` is `.git`.
  return real && !OFF_LIMITS.has(real.inside.split(sep)[0]!.toLowerCase()) ? real.full : undefined;
}

/**
 * The real path of `path` (relative to `dir`, or absolute), and that path relative to `dir`'s real
 * path, when it lies under it or is it; undefined otherwise. Real as far as it exists: its parent's
 * real path (the nearest directory that exists, followed by the rest), and the file's own when it
 * is a link, so a link never leads out.
 */
export async function realWithin(dir: string, path: string): Promise<{ full: string; inside: string } | undefined> {
  const root = await realpath(dir);
  const wanted = resolve(root, path);
  let full: string | undefined = join(await realParent(dirname(wanted)), basename(wanted));
  // A link is followed to what it names, which must be inside too; a broken one names nothing.
  if ((await lstat(full).catch(() => undefined))?.isSymbolicLink()) full = await realpath(full).catch(() => undefined);
  return full !== undefined && within(root, full) ? { full, inside: relative(root, full) } : undefined;
}

/** What an agent is told when the checkout rule refuses `path`. */
export const outsideCheckout = (path: string) => `${path} is outside your checkout, or under .git or node_modules`;

/** `path` under `root` as the checkout rule allows it, or the refusal the agent reads. */
export async function mustAllow(root: string, path: string): Promise<string> {
  const full = await allowedPath(root, path);
  if (full === undefined) throw new Error(outsideCheckout(path));
  return full;
}

/** What a coding agent is told when the checkout rule refuses a shell command. */
export const NO_SHELL =
  "No shell commands in this chat until previews exist: edit the files; the checks run after your turn";

/** Whether the absolute path `full` is `dir` or under it, by their paths as given. */
export function within(dir: string, full: string): boolean {
  const inside = relative(dir, full);
  return inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

/** A repository a chat can draft in. */
export type Drafting = Source & Required<Pick<Source, "draft" | "diff">>;

/** The instance's repository, as every engine drafts in it; an error when it has none to draft in. */
export function drafting(app: AppContext): Drafting {
  const repo = app.source;
  if (!repo?.draft || !repo.diff) throw new Error("This instance has no repository to draft a change in");
  return repo as Drafting;
}

/**
 * The coding agents' state of the kind `kind`, kept across restarts under `.sanoma/agent-home`,
 * one directory per kind so that no engine's files cover another's: `harness`, the company-key
 * session's home (its bridges' installs and run files, Pi's settings); `acp`, a person's own
 * agents' installs (`acp/<agent>`, the shims, pnpm's store); `people`, each person's own `HOME`
 * (`people/<id>`), where only that person's agent keeps its sign-in and nothing of ours reads.
 */
export const agentHome = (app: AppContext, kind: "harness" | "acp" | "people") =>
  join(drafting(app).root, ".sanoma", "agent-home", kind);

/** The chat's draft, opened (or found open), and attached to the chat's row the first time. */
export async function openDraft(app: AppContext, chat: Chat): Promise<Draft> {
  const opened = await drafting(app).draft(chat.id);
  if (chat.draftId !== chat.id) {
    await app.client.chats.attach(chat.id, chat.id);
    chat.draftId = chat.id;
  }
  return opened;
}

/**
 * Tells the change of the draft `id`, when it has one under way, that its branch has new commits,
 * as `by` (`SanomaClient.changeEvent`): its run plans again and withdraws a Publish asked on the
 * old head. Nothing when the draft has no change, or its change has ended. A notice that fails is
 * logged, never the turn's failure: the commit has landed, and the merge refuses a head that moved.
 */
export async function tellCommits(client: SanomaClient, id: string, by: Principal): Promise<void> {
  try {
    await client.changeEvent(id, { kind: "commits" }, { by });
  } catch (err) {
    if (!NO_CHANGE.has(errorCode(err) ?? ""))
      console.error(`sanoma app: telling the change of ${id} its new commits failed:`, err);
  }
}

/** What `changeEvent` fails with for a draft with no change under way. */
const NO_CHANGE = new Set(["run_not_found", "run_ended"]);

/**
 * The end of a coding agent's turn, however it ended (an error too): what it changed committed on
 * the chat's draft as the person, under `title` and their message, its change told (`tellCommits`),
 * then, unless a new message stopped it (the next turn shows the card), the draft's card
 * (`data-draft`) from its checks and its diff.
 */
export async function commitTurn(
  { app, chat, messages, principal, signal }: EngineTurn,
  draft: Draft,
  title: string,
  writer: UIMessageStreamWriter<ChatMessage>,
) {
  const message = `${title}: ${textOf(messages.at(-1)!, " ").trim().slice(0, 72)}`;
  const committed = (await draft.commit({ paths: ["."], message, author: principal.id })) !== undefined;
  if (!committed) return;
  // Told even when the turn was stopped: the commit has landed.
  const told = tellCommits(app.client, chat.id, principal);
  if (signal.aborted) return told;
  const [checked, diff] = await Promise.all([checks(app, chat.id), drafting(app).diff(chat.id), told]);
  writer.write({
    type: "data-draft",
    id: "draft",
    data: { draft: chat.id, branch: draft.branch, ...diff, checks: checked },
  });
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
