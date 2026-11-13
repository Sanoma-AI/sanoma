import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
  type AppMerge,
  type ChatTurnContext,
  type Chat,
  type CheckResult,
  type Draft,
  errorCode,
  isEnded,
  type RunSummary,
  type SanomaConfig,
} from "sanoma/workflows";
import { chatAgentActing, type ConfigDescription, describeConfig, readPeople } from "sanoma/workflows/describe";
import { tool } from "ai";
import { z } from "zod";
import { catalogCallId, type DraftCard, type HeldOutput, type LookupOutput, type RunOutput } from "../../lib/chat.ts";
import {
  CATALOG,
  type CatalogName,
  describedOn,
  lookupOutput,
  runCatalog,
  runOutput,
  startDrift,
  stillHeld,
} from "../../server/catalog.ts";
import { type CallHost, noRun, RESULT_WAIT_MS } from "../../server/core.ts";
import { checks, drafting, mustAllow, openDraft, tellCommits } from "./checkout.ts";

// Our loop's tools: reading the repository, editing the chat's draft (opened by the first edit,
// committed at each), taking and updating an app there (a git merge of its source), its checks,
// and the agent catalog (`catalogTools`), which both engines get. No shell: the draft sits in the
// live checkout until previews exist. Every path goes through the checkout rule (`allowedPaths`).

/** What the tools act for: the turn's step (the worker's client and repository, the person), the chat (whose `draftId` the first edit sets) and the id of the person's message the turn answers (`ChatTurnInput.message`). */
export interface ToolsTurn {
  step: ChatTurnContext;
  chat: Chat;
  message: string;
  /** Shows the draft's card in the reply, as it now stands. */
  showDraft(card: DraftCard): void;
}

/** The most a read gives the model, in characters; a longer file is cut, saying so. */
const READ_LIMIT = 100_000;
/** The most lines a listing or a search gives. */
const LINES_LIMIT = 500;
/** How often a held call or start looks at its run: first after a second, then less often, to every 10 s. */
const HELD_POLL_MS = [1000, 10_000] as const;
/** How long our loop's catalog tool waits on a held call or start for its decision before answering that it waits. */
const LOOP_HELD_MS = 10 * 60_000;
/** How long a catalog tool waits for a held start's run to end once its approval is decided. */
const DECIDED_WAIT_MS = 5000;
/** The longest a catalog tool takes to answer in a coding agent's turn: well before an MCP client in the box gives up on it. */
const HARNESS_ANSWER_MS = 40_000;
/**
 * How long a catalog tool waits on a held call or start for its decision in a coding agent's turn:
 * what `HARNESS_ANSWER_MS` leaves after a start's own wait (`RESULT_WAIT_MS`) and the wait after a
 * decision (`DECIDED_WAIT_MS`), so a call answers within it, its run's id in the answer.
 */
export const HARNESS_HELD_MS = HARNESS_ANSWER_MS - RESULT_WAIT_MS - DECIDED_WAIT_MS;
/** How often a catalog tool looks at a run it started, until it ends or waits: first after a quarter second, to every 2 s. */
const STARTED_POLL_MS = [250, 2000] as const;

const git = promisify(execFile);

/** The loop's tools for a turn of `turn.chat`. */
export function loopTools(turn: ToolsTurn) {
  const { step, chat } = turn;
  const { client, by: principal } = step;
  let opening: Promise<Draft> | undefined;
  /** The checks since the last edit, for the card. */
  let checked: CheckResult | undefined;

  /** The chat's draft, opened (and attached to the chat) by the first call. */
  const draft = () =>
    (opening ??= openDraft(step, chat).catch((err: unknown) => {
      opening = undefined;
      throw err;
    }));
  /** Whether the chat's draft is open: one this turn opened, or one still there from an earlier turn. */
  let drafted: Promise<boolean> | undefined;
  const hasDraft = () =>
    opening
      ? Promise.resolve(true)
      : (drafted ??= chat.draftId
          ? (drafting(step).drafts?.() ?? Promise.resolve([])).then((ids) => ids.includes(chat.id))
          : Promise.resolve(false));
  /**
   * Where reads look: the chat's open draft, else the live checkout (a merged and deleted draft is
   * not opened again by a read), at its commit either way.
   */
  const readRoot = async () => ((await hasDraft()) ? (await draft()).root : drafting(step).root);
  const showCard = async () => {
    const { branch } = await draft();
    turn.showDraft({
      draft: chat.id,
      branch,
      ...(await drafting(step).diff(chat.id)),
      ...(checked && { checks: checked }),
    });
  };
  /**
   * The turn's writes and checks, one at a time: the model may call several tools at once, and a
   * merge must never see another edit's file uncommitted, nor an edit or the checks a merge half
   * done (the reads read the draft's last commit).
   */
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const done = queue.then(run);
    queue = done.catch(() => undefined);
    return done;
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
    await Promise.all([committed && tellCommits(client, chat.id, principal), showCard()]);
    return { path: file, committed: committed?.revision ?? "nothing changed" };
  };

  /** An app merged into the draft by `merge`, the card shown, and what the agent does next. */
  const mergeApp = (merge: (draft: Draft) => Promise<AppMerge> | undefined) =>
    inTurn(async () => {
      const merging = merge(await draft());
      if (!merging) throw new Error("This instance's repository cannot merge an app into a draft");
      const merged = await merging;
      checked = undefined;
      await showCard();
      const next = merged.conflicts.length
        ? "Each file in conflicts is committed with git's conflict markers (<<<<<<< the company's, ||||||| the base, ======= the source's, >>>>>>>), a binary one as the company's: resolve each with edit_file, keeping what both sides meant, then run run_checks"
        : merged.merged
          ? "Merged clean: run run_checks"
          : "Nothing new to merge";
      return { ...merged, next };
    });

  return {
    connection_status: tool({
      description:
        "Read named account requirements and last-tested status, with links to secure input. Never returns credentials or tests a provider.",
      inputSchema: z.object({}),
      execute: async () =>
        (await client.connections({ actor: principal })).map((card) => ({
          ...card,
          secureInput: `/connectors/${encodeURIComponent(card.vendor)}`,
        })),
    }),
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
      execute: ({ path, content, message }) => inTurn(() => save(path, content, message)),
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
      execute: ({ path, old, new: replacement, message }) =>
        inTurn(async () => {
          const full = await mustAllow((await draft()).root, path);
          const text = await readFile(full, "utf8");
          const count = text.split(old).length - 1;
          if (count !== 1)
            throw new Error(`${path} has the passage ${count} times, not once: quote more of it, exactly`);
          return save(
            path,
            text.replace(old, () => replacement),
            message,
          );
        }),
    }),
    take_app: tool({
      description:
        "Take an app into your draft: merge its source repository (a public company repo holding one apps/<name>/, by https) with its history, as one merge commit. The app arrives as apps/<name>/ and package.json gets the source's beside the company's (its connectors); every other file stays the company's. Then resolve any conflicts and run run_checks.",
      inputSchema: z.object({
        url: z.string().describe("The source repository's https URL, such as https://github.com/acme/crm"),
        ref: z
          .string()
          .optional()
          .describe(
            "A branch, tag or full commit id of it; its default branch when left out (an update follows the default branch)",
          ),
        folder: z
          .string()
          .optional()
          .describe("The app's folder in the source (apps/<folder>/), needed only when it holds more than one"),
      }),
      execute: ({ url, ref, folder }) => mergeApp((d) => d.take?.({ url, ref, folder, author: principal.id })),
    }),
    update_app: tool({
      description:
        "Merge the new commits of an app's source (the repository its apps/<folder>/app.ts names) into your draft, as one merge commit: what they change in apps/<folder>/ and package.json; every other file stays the company's. A line both the company and the source changed conflicts: resolve it, then run run_checks.",
      inputSchema: z.object({ folder: z.string().describe("The app's folder: apps/<folder>/") }),
      execute: ({ folder }) => mergeApp((d) => d.update?.({ folder, author: principal.id })),
    }),
    run_checks: tool({
      description:
        "Run `sanoma check` on your draft: types, the workflow lint, the data files and the scenarios. Run it after your edits and fix what it finds.",
      inputSchema: z.object({}),
      execute: () =>
        inTurn(async () => {
          if (!(await hasDraft())) throw new Error("Nothing is drafted yet: edit a file first");
          checked = await checks(step, chat.id);
          await showCard();
          return checked;
        }),
    }),
    ...catalogTools(turn, { heldMs: LOOP_HELD_MS }),
  };
}

/** Our loop's tools, as the chat's messages type them. */
export type LoopTools = ReturnType<typeof loopTools>;

/** Each config's description (`describeConfig`), made once: what the catalog reads of the company. */
const descriptions = new WeakMap<SanomaConfig, ConfigDescription>();
const describedOf = (config: SanomaConfig) => {
  let description = descriptions.get(config);
  if (!description) descriptions.set(config, (description = describeConfig(config)));
  return description;
};

/** The catalog's tool `name`, as the AI SDK's `tool` takes it, described as the chat has it (`describedOn`: no `id` to send, a hold and a failed run as outputs). */
const spec = <N extends CatalogName>(name: N) => {
  const { title, input } = CATALOG[name];
  return { title, description: describedOn(name, "chat"), inputSchema: input as (typeof CATALOG)[N]["input"] };
};

/**
 * The agent catalog (`server/catalog.ts`, the tools `/mcp` serves) as AI SDK tools for a turn of
 * `turn.chat`, run in the worker against the turn's step (its client, resolved config and the
 * config's description) as the in-app chat's agent acting for the person chatting
 * (`chatAgentActing`), so the policy is asked as it and as them and the ledger records both. A
 * tool that takes an idempotency id is given `catalogCallId` of the chat, the turn's message
 * (`turn.message`) and the tool call, one call per tool call. A held lookup, or a start
 * (`start_run`, `drift`) whose run waits for an approval, shows the held output
 * (`{ held: { runId } }`, the chat's approval card) at once and waits up to `heldMs` for the
 * decision; past it, it answers that it waits, for whom, with the run's id (`StillHeld`, which
 * `settle` replaces with the run's state once it is decided). A started run that is not held is
 * waited for at most `RESULT_WAIT_MS`. A start answers the one shape whatever became of its run
 * (`RunOutput`, built by `runOutput`): a run that started and then failed is an output with its id
 * and its error, never the tool's error, which is only for a call that left no run (a refusal, an
 * input it does not take). Every wait here ends with the turn (its abort signal): the tool's own
 * polls, and `wait_run`'s wait in `callApi`, which is given the signal.
 * HarnessAgent's engines run these on the host too, never in the box.
 */
export function catalogTools(
  { step, chat, message }: Pick<ToolsTurn, "step" | "chat" | "message">,
  { heldMs }: { heldMs: number },
) {
  const { client } = step;
  const host = (): CallHost => ({
    client,
    resolved: step.resolved,
    snapshot: { description: describedOf(step.config) },
  });
  /** The chat's agent for the turn's person (the people's files as they are now). */
  const actor = () => chatAgentActing(step.by.id, readPeople(step.resolved.root));
  /** The idempotency id of the tool call `toolCallId` in this turn. */
  const idOf = (toolCallId: string) => catalogCallId(chat.id, message, toolCallId);
  /** The tool `name` called with `args` as the chat's agent, by the tool call's id where it takes one, its wait ended by `signal`. */
  const call = (
    name: CatalogName,
    args: unknown,
    { toolCallId, signal }: { toolCallId?: string; signal?: AbortSignal },
  ) =>
    runCatalog(host(), name, args, {
      actor: actor(),
      ...(toolCallId !== undefined && { id: idOf(toolCallId) }),
      ...(signal && { signal }),
    });
  /** The run `runId`, read every `steps` (doubling) until `done` says so of it or `until` passes; undefined once it is gone. */
  const poll = async (
    runId: string,
    until: number,
    done: (run: RunSummary) => boolean,
    signal: AbortSignal | undefined,
    steps: readonly [number, number] = HELD_POLL_MS,
  ): Promise<RunSummary | undefined> => {
    for (let wait: number = steps[0]; ; wait = Math.min(wait * 2, steps[1])) {
      signal?.throwIfAborted();
      const run = await client.run(runId);
      if (!run || done(run) || Date.now() >= until) return run;
      await sleep(Math.min(wait, until - Date.now()), undefined, { signal });
    }
  };
  /** The run `runId` read until it ends or waits for an approval, for `ms` at most. */
  const settled = async (runId: string, ms: number, signal: AbortSignal | undefined) => {
    const run = await poll(
      runId,
      Date.now() + ms,
      (r) => isEnded(r.status) || r.status === "waiting",
      signal,
      STARTED_POLL_MS,
    );
    if (!run) throw noRun(runId);
    return run;
  };
  /**
   * A started run watched for `startMs` (`RESULT_WAIT_MS` at most, and when not given), until it
   * ends or waits for an approval; one that waits shows the held output, then is waited for up to
   * `heldMs` for the decision, and once it is decided up to `DECIDED_WAIT_MS` more for its end.
   * Its answer is the run's, as it then stands (`runOutput`): finished with its output, failed with
   * its error, still running, or still held.
   */
  async function* watched(
    runId: string,
    signal: AbortSignal | undefined,
    startMs = RESULT_WAIT_MS,
  ): AsyncGenerator<RunOutput, RunOutput> {
    const started = await settled(runId, Math.min(startMs, RESULT_WAIT_MS), signal);
    if (started.status !== "waiting") return runOutput(client, started);
    yield { held: { runId } } satisfies HeldOutput;
    const decided = await poll(runId, Date.now() + heldMs, (r) => r.status !== "waiting", signal);
    if (!decided) throw noRun(runId);
    if (decided.status === "waiting" || isEnded(decided.status)) return runOutput(client, decided);
    return runOutput(client, await settled(runId, DECIDED_WAIT_MS, signal));
  }

  return {
    describe: tool({ ...spec("describe"), execute: (args) => call("describe", args, {}) }),
    lookup: tool({
      ...spec("lookup"),
      async *execute(args, { toolCallId, abortSignal }): AsyncGenerator<LookupOutput> {
        let output: unknown;
        try {
          output = await call("lookup", args, { toolCallId });
        } catch (err) {
          const runId = heldRun(err);
          if (runId === undefined) throw err;
          yield { held: { runId } };
          const run = await poll(runId, Date.now() + heldMs, (r) => isEnded(r.status), abortSignal);
          if (run && !isEnded(run.status)) {
            yield stillHeld(run);
            return;
          }
          output = await client.result(runId);
        }
        yield lookupOutput(output);
      },
    }),
    get_run: tool({ ...spec("get_run"), execute: (args) => call("get_run", args, {}) }),
    wait_run: tool({
      ...spec("wait_run"),
      execute: (args, { abortSignal }) => call("wait_run", args, { signal: abortSignal }),
    }),
    drift: tool({
      ...spec("drift"),
      async *execute({ waitMs }, { toolCallId, abortSignal }): AsyncGenerator<RunOutput> {
        // Started without waiting, then watched as a start is: a drift the policy holds shows at once.
        const { runId } = await startDrift(host(), actor(), idOf(toolCallId));
        yield yield* watched(runId, abortSignal, waitMs);
      },
    }),
    start_run: tool({
      ...spec("start_run"),
      async *execute(args, { toolCallId, abortSignal }): AsyncGenerator<RunOutput> {
        const { runId } = (await call("start_run", args, { toolCallId })) as { runId: string };
        yield yield* watched(runId, abortSignal);
      },
    }),
  };
}

/** The held call's run a direct call's `approval_pending` names. */
const heldRun = (err: unknown): string | undefined => {
  const runId = (err as { data?: { runId?: unknown } }).data?.runId;
  return errorCode(err) === "approval_pending" && typeof runId === "string" ? runId : undefined;
};

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
