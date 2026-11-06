import nodeFs from "node:fs";
import nodePath, { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type AppStepContext,
  type Box,
  type Chat,
  type CheckResult,
  type Draft,
  errorCode,
  type Principal,
  type SanomaClient,
  type Source,
} from "@sanoma-ai/workflows";
import type { UIMessageStreamWriter } from "ai";
import { type ChatMessage, textOf } from "../../lib/chat.ts";
import type { EngineTurn } from "./transcript.ts";

/** Where an agent may never write in a checkout: git's own files, and the install (`node_modules`, a link to the live one in a draft). */
const OFF_LIMITS = new Set([".git", "node_modules"]);

/**
 * The real paths of the absolute `paths` where they are, each as far as it exists: its parent's
 * real path (the nearest directory that exists, followed by the rest), and its own when it is a
 * link, so a link never leads out; null for a broken link, which names nothing.
 */
export type RealPaths = <const T extends readonly string[]>(paths: T) => Promise<{ [K in keyof T]: string | null }>;

/**
 * `RealPaths` over the file system `fs` and its paths, `path`. Self-contained, so that a box runs
 * this very function on its own files (`realIn`, which sends its text to the box's Node).
 */
function realPaths(fs: typeof import("node:fs"), path: typeof import("node:path"), paths: readonly string[]) {
  const real = (dir: string): string => {
    try {
      return fs.realpathSync(dir);
    } catch {
      const up = path.dirname(dir);
      return up === dir ? dir : path.join(real(up), path.basename(dir));
    }
  };
  return paths.map((wanted) => {
    const full = path.join(real(path.dirname(wanted)), path.basename(wanted));
    try {
      if (!fs.lstatSync(full).isSymbolicLink()) return full;
    } catch {
      return full;
    }
    try {
      return fs.realpathSync(full);
    } catch {
      return null;
    }
  });
}

/** `RealPaths` on this machine's files: the live instance's, where our loop drafts. */
export const here: RealPaths = async (paths) => realPaths(nodeFs, nodePath, paths) as never;

/** `RealPaths` on `box`'s files, by its Node: a coding agent's paths are checked where its files are. */
export const realIn =
  (box: Box): RealPaths =>
  async (paths) => {
    const script = `process.stdout.write(JSON.stringify((${realPaths.toString()})(require("node:fs"), require("node:path"), JSON.parse(process.env.PATHS))))`;
    const ran = await box.run('exec node -e "$SCRIPT"', { env: { SCRIPT: script, PATHS: JSON.stringify(paths) } });
    const [out, err, { exitCode }] = await Promise.all([
      new Response(ran.stdout).text(),
      new Response(ran.stderr).text(),
      ran.wait(),
    ]);
    if (exitCode !== 0) throw new Error(`The box ${box.id} could not check a path (exit ${exitCode}): ${err.trim()}`);
    return JSON.parse(out) as never;
  };

/**
 * The checkout rule: the absolute path `path` (relative to `worktree`, or absolute) names, when an
 * agent may read or write it there; undefined when it may not. Its real path (`real`: this
 * machine's, or a box's, `realIn`) must lie under the worktree's (the worktree itself is allowed,
 * for a listing), and its first segment there may not be `.git` or `node_modules` (a draft's
 * `node_modules` is a link into the live install). One rule for every engine: our loop's tools,
 * `HarnessAgent`'s permission requests and an ACP agent's.
 */
export async function allowedPath(worktree: string, path: string, real: RealPaths = here): Promise<string | undefined> {
  const [root, full] = await real([resolve(worktree), resolve(worktree, path)]);
  return inCheckout(root, full);
}

/** The checkout rule on real paths: `full` when it lies under the checkout's `root` but not under `.git` or `node_modules` there. */
export function inCheckout(root: string | null, full: string | null): string | undefined {
  if (root === null || full === null || !within(root, full)) return undefined;
  // Lower-cased: on a case-insensitive file system (macOS's default) `.GIT` is `.git`.
  return OFF_LIMITS.has(relative(root, full).split(sep)[0]!.toLowerCase()) ? undefined : full;
}

/** What an agent is told when the checkout rule refuses `path`. */
export const outsideCheckout = (path: string) => `${path} is outside your checkout, or under .git or node_modules`;

/** `path` under `root` as the checkout rule allows it (`real`: where its files are), or the refusal the agent reads. */
export async function mustAllow(root: string, path: string, real: RealPaths = here): Promise<string> {
  const full = await allowedPath(root, path, real);
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

/** The worker's repository, as every engine drafts in it; an error when it has none to draft in. */
export function drafting({ source }: Pick<AppStepContext, "source">): Drafting {
  if (!source?.draft || !source.diff) throw new Error("This instance has no repository to draft a change in");
  return source as Drafting;
}

/**
 * `sanoma check` on the draft `id`, as the repository runs it (`Source.check`), for a draft's card
 * and the agent that drafts: its problems and warnings, without the grid, which a change's review reads.
 */
export async function checks({ source }: Pick<AppStepContext, "source">, id: string): Promise<CheckResult> {
  if (!source?.check) {
    return { ok: false, problems: ["sanoma check: this instance's repository cannot check a draft"], warnings: [] };
  }
  const { grid: _, ...checked } = await source.check(id);
  return checked;
}

/**
 * The coding agents' state of the kind `kind`, kept across restarts under `.sanoma/agent-home`,
 * one directory per kind: `boxes`, the local backend's boxes (`boxes/<name>`, each a person's
 * home for the company: their company-key sessions' bridges' installs and run files, Pi's
 * settings, and their own agents' installs, shims and sign-ins under `.acp`).
 */
export const agentHome = (step: Pick<AppStepContext, "source">, kind: "boxes") =>
  join(drafting(step).root, ".sanoma", "agent-home", kind);

/**
 * An id as a directory name: never `.`, `..` or a path, and capitals escaped, so ids that differ
 * only in case never share a HOME on a case-insensitive file system (macOS's default).
 */
const personDir = (id: string) =>
  encodeURIComponent(id).replaceAll(/[.A-Z]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * The box a person's coding agents work in for the company `company` (its app's name): one per
 * person per company, each part `personDir`'s with its dashes escaped too, so no two pairs share one.
 */
export const boxName = (company: string, person: string) =>
  `sanoma-${[company, person].map((id) => personDir(id).replaceAll("-", "%2D")).join("-")}`;

/** The chat's draft, opened (or found open), and attached to the chat's row the first time. */
export async function openDraft(step: Pick<AppStepContext, "source" | "client">, chat: Chat): Promise<Draft> {
  const opened = await drafting(step).draft(chat.id);
  if (chat.draftId !== chat.id) {
    await step.client.chats.attach(chat.id, chat.id);
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

/** A coding agent's turn's commit message: the engine's `title` and the person's message. */
export const turnMessage = ({ messages }: Pick<EngineTurn, "messages">, title: string) =>
  `${title}: ${textOf(messages.at(-1)!, " ").trim().slice(0, 72)}`;

/**
 * A coding agent's turn's new commits on the chat's draft, made in its box and carried back (`carryOut`), its
 * change told (`tellCommits`), then, unless a new message stopped the turn (the next turn shows
 * the card), the draft's card (`data-draft`) from its checks and its diff.
 */
export async function showCommits(
  { step, chat }: EngineTurn,
  draft: Draft,
  writer: UIMessageStreamWriter<ChatMessage>,
) {
  // Told even when the turn was stopped: the commit has landed.
  const told = tellCommits(step.client, chat.id, step.by);
  if (step.signal.aborted) return told;
  const [checked, diff] = await Promise.all([checks(step, chat.id), drafting(step).diff(chat.id), told]);
  writer.write({
    type: "data-draft",
    id: "draft",
    data: { draft: chat.id, branch: draft.branch, ...diff, checks: checked },
  });
}
