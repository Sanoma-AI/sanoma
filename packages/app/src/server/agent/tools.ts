import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
  type Chat,
  type CheckResult,
  type Draft,
  errorCode,
  isDirect,
  isEnded,
  type Principal,
  type Source,
} from "@sanoma-ai/workflows";
import { tool } from "ai";
import { z } from "zod";
import type { AppContext } from "../../context.ts";
import type { DraftCard, HeldOutput } from "../../lib/chat.ts";
import { checks } from "../drafts.ts";
import { allowedPath } from "./checkout.ts";

// Our loop's tools: reading the repository, editing the chat's draft (opened by the first edit,
// committed at each), its checks, and lookups through the policy. No shell: the draft sits in the
// live checkout until previews exist. Every path goes through the checkout rule (`allowedPath`).

/** What the tools act for: the app, the chat (whose `draftId` the first edit sets) and the person. */
export interface ToolsTurn {
  app: AppContext;
  chat: Chat;
  principal: Principal;
  /** Shows the draft's card in the reply, as it now stands. */
  showDraft(card: DraftCard): void;
}

/** The most a read gives the model, in characters; a longer file is cut, saying so. */
const READ_LIMIT = 100_000;
/** The most lines a listing or a search gives. */
const LINES_LIMIT = 500;
/** How often a held lookup looks at its run: first after a second, then less often, to every 10 s. */
const HELD_POLL_MS = [1000, 10_000] as const;

const git = promisify(execFile);

/** The loop's tools for a turn of `turn.chat`. */
export function loopTools(turn: ToolsTurn) {
  const { app, chat, principal } = turn;
  let opening: Promise<Draft> | undefined;
  /** The checks since the last edit, for the card. */
  let checked: CheckResult | undefined;

  const source = (): Drafting => {
    const repo = app.source;
    if (!repo?.draft || !repo.diff) throw new Error("This instance has no repository to draft a change in");
    return repo as Drafting;
  };
  /** The chat's draft, opened (and attached to the chat) by the first call. */
  const draft = () =>
    (opening ??= (async () => {
      const opened = await source().draft(chat.id);
      if (chat.draftId !== chat.id) {
        await app.client.chats.attach(chat.id, chat.id);
        chat.draftId = chat.id;
      }
      return opened;
    })().catch((err: unknown) => {
      opening = undefined;
      throw err;
    }));
  /** Whether the chat's draft is open: one this turn opened, or one still there from an earlier turn. */
  let drafted: Promise<boolean> | undefined;
  const hasDraft = () =>
    opening
      ? Promise.resolve(true)
      : (drafted ??= chat.draftId
          ? (source().drafts?.() ?? Promise.resolve([])).then((ids) => ids.includes(chat.id))
          : Promise.resolve(false));
  /**
   * Where reads look: the chat's open draft, else the live checkout (a merged and deleted draft is
   * not opened again by a read), at its commit either way.
   */
  const readRoot = async () => ((await hasDraft()) ? (await draft()).root : source().root);
  const showCard = async () => {
    const { branch } = await draft();
    turn.showDraft({ branch, ...(await source().diff(chat.id)), ...(checked && { checks: checked }) });
  };
  /** Writes `text` at `path` in the draft and commits it with `message`. */
  const save = async (path: string, text: string, message: string) => {
    const { root, commit } = await draft();
    const full = await mustAllow(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text);
    const file = await inRepo(root, full);
    const committed = await commit({ paths: [file], message, author: principal.id });
    checked = undefined;
    await showCard();
    return { path: file, committed: committed?.revision ?? "nothing changed" };
  };

  return {
    list_files: tool({
      description:
        "List the repository's files (those git tracks), under a directory or all of them. In the draft once you have edited.",
      inputSchema: z.object({
        path: z.string().default(".").describe("A directory, relative to the repository's root"),
      }),
      execute: async ({ path }) => {
        const root = await readRoot();
        const dir = await inRepo(root, await mustAllow(root, path));
        return limitLines(
          (await git("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", dir || "."], { cwd: root })).stdout,
        );
      },
    }),
    read_file: tool({
      description: "Read a file the repository tracks, as committed. In the draft once you have edited.",
      inputSchema: z.object({ path: z.string().describe("The file, relative to the repository's root") }),
      execute: async ({ path }) => {
        const root = await readRoot();
        const file = await inRepo(root, await mustAllow(root, path));
        const { stdout } = await git("git", ["show", `HEAD:${file}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
        return stdout.length > READ_LIMIT
          ? `${stdout.slice(0, READ_LIMIT)}\n[cut at ${READ_LIMIT} characters of ${stdout.length}]`
          : stdout;
      },
    }),
    grep: tool({
      description:
        "Search the repository's tracked files for a regular expression (git grep, extended), with line numbers. In the draft once you have edited.",
      inputSchema: z.object({
        pattern: z.string().min(1).describe("An extended regular expression"),
        path: z.string().default(".").describe("A directory or file to search in, relative to the root"),
      }),
      execute: async ({ pattern, path }) => {
        const root = await readRoot();
        const where = await inRepo(root, await mustAllow(root, path));
        const found = await git("git", ["grep", "-n", "-I", "-E", "-e", pattern, "HEAD", "--", where || "."], {
          cwd: root,
          maxBuffer: 16 * 1024 * 1024,
        }).catch((err: { code?: unknown; stdout?: string }) => {
          // git grep exits 1 when nothing matches.
          if (err.code === 1) return { stdout: "" };
          throw err;
        });
        return limitLines(found.stdout.replaceAll(/^HEAD:/gm, "")) || "No matches";
      },
    }),
    write_file: tool({
      description:
        "Write a whole file in your draft (made from the live checkout at your first edit) and commit it. Create or replace.",
      inputSchema: z.object({
        path: z.string().describe("The file, relative to the repository's root"),
        content: z.string().describe("The file's whole new text"),
        message: z.string().min(1).describe("The commit message: what this change does, in a line"),
      }),
      execute: ({ path, content, message }) => save(path, content, message),
    }),
    edit_file: tool({
      description:
        "Replace one exact passage of a file in your draft and commit it. The passage must occur exactly once: include enough around it.",
      inputSchema: z.object({
        path: z.string().describe("The file, relative to the repository's root"),
        old: z.string().min(1).describe("The exact text to replace, once in the file"),
        new: z.string().describe("Its replacement"),
        message: z.string().min(1).describe("The commit message: what this change does, in a line"),
      }),
      execute: async ({ path, old, new: replacement, message }) => {
        const full = await mustAllow((await draft()).root, path);
        const text = await readFile(full, "utf8");
        const count = text.split(old).length - 1;
        if (count !== 1) throw new Error(`${path} has the passage ${count} times, not once: quote more of it, exactly`);
        return save(
          path,
          text.replace(old, () => replacement),
          message,
        );
      },
    }),
    run_checks: tool({
      description:
        "Run `sanoma check` on your draft: types, the workflow lint, the data files and the scenarios. Run it after your edits and fix what it finds.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasDraft())) throw new Error("Nothing is drafted yet: edit a file first");
        checked = await checks((await draft()).root, app.resolved.databaseUrl);
        await showCard();
        return checked;
      },
    }),
    lookup: tool({
      description:
        "Call an operation whose effect is read (a lookup listed in your instructions) as the person, through the company's policy. A held one waits for its approver's decision.",
      inputSchema: z.object({
        op: z.string().describe("The operation's id, such as ghost.post.list"),
        input: z.record(z.string(), z.unknown()).default({}).describe("Its input"),
      }),
      async *execute({ op, input }, { toolCallId, abortSignal }): AsyncGenerator<HeldOutput | { output: unknown }> {
        const declared = app.resolved.ops.get(op);
        if (declared?.effect !== "read" || !isDirect(declared, app.resolved.types)) {
          throw new Error(`${op} is not a lookup: only a read your instructions list as one is`);
        }
        let output: unknown;
        try {
          // One run per tool call: the chat's and the call's ids, so the run is the chat's alone.
          output = await app.client.call(op, input, { actor: principal, id: `${chat.id}:${toolCallId}` });
        } catch (err) {
          const runId = heldRun(err);
          if (runId === undefined) throw err;
          yield { held: { runId } };
          for (let wait: number = HELD_POLL_MS[0]; !isEnded((await app.client.run(runId))?.status ?? "failed");) {
            await sleep(wait, undefined, { signal: abortSignal });
            wait = Math.min(wait * 2, HELD_POLL_MS[1]);
          }
          output = await app.client.result(runId);
        }
        yield { output };
      },
    }),
  };
}

/** Our loop's tools, as the chat's messages type them. */
export type LoopTools = ReturnType<typeof loopTools>;

/** A repository the chat can draft in. */
type Drafting = Source & Required<Pick<Source, "draft" | "diff">>;

/** The held call's run a direct call's `approval_pending` names. */
const heldRun = (err: unknown): string | undefined => {
  const runId = (err as { data?: { runId?: unknown } }).data?.runId;
  return errorCode(err) === "approval_pending" && typeof runId === "string" ? runId : undefined;
};

/** `path` under `root` as the checkout rule allows it, or the refusal the model reads. */
async function mustAllow(root: string, path: string): Promise<string> {
  const full = await allowedPath(root, path);
  if (full === undefined) throw new Error(`${path} is outside your checkout, or under .git or node_modules`);
  return full;
}

/** `full`, inside `root`, as a path from the repository's root with `/`; empty for the root itself. */
async function inRepo(root: string, full: string): Promise<string> {
  return relative(await realpath(root), full)
    .split(sep)
    .join("/");
}

/** The first lines of `text`, saying how many were left out. */
function limitLines(text: string): string {
  const lines = text.trimEnd().split("\n");
  return lines.length > LINES_LIMIT
    ? `${lines.slice(0, LINES_LIMIT).join("\n")}\n[${lines.length - LINES_LIMIT} more lines]`
    : lines.join("\n");
}
