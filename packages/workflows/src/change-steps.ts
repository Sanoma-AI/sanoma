import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { withdrawApprovals } from "./approvals.ts";
import { decide } from "./call.ts";
import {
  ADMIN,
  type ChangeDecision,
  type ChangeDeploy,
  type ChangeEvent,
  ChangeEventSchema,
  type ChangeFacts,
  type ChangeState,
  type ChangeVerified,
  repositoryOf,
  isRules,
  sourceOfRun,
  touchesOf,
} from "./change.ts";
import type { ChangeSteps } from "./change-workflow.ts";
import type { DriftReport } from "./drift.ts";
import { isRunControlError } from "./errors.ts";
import { warn } from "./log.ts";
import { inside } from "./paths.ts";
import { DECLARES_PEOPLE } from "./resources.ts";
import { currentRun, type Run } from "./run.ts";
import {
  AGENTS,
  APPLY_WORKFLOW,
  CHANGE_EVENT,
  CHANGE_MERGE,
  CHANGE_TOPIC,
  DRIFT_WORKFLOW,
  errorMessage,
} from "./shared.ts";
import type { CheckResult, RemoteHalf } from "./source.ts";

// The change workflow's steps that are not one of its operations: checking and planning the
// draft, asking the policy ahead, waiting for what happens to the change, retiring approvals,
// deploying and verifying after the merge, and publishing where the change is. Here, not in
// change-workflow.ts, which is held to the workflow lint and imports no DBOS; each reads its run
// from `currentRun`.

const runNow = (): Run => {
  const run = currentRun.getStore();
  if (!run) throw new Error("A change step ran outside its run");
  return run;
};

/** True when the file at `path` is a people file (`DECLARES_PEOPLE`), one `readPeople` would read; false when there is none. */
const fileDeclaresPeople = async (path: string) => DECLARES_PEOPLE.test(await readFile(path, "utf8").catch(() => ""));

/** Which events win when several wait: one that ends the change over one that plans it again. */
const WEIGHT: Record<ChangeEvent["kind"], number> = { commits: 0, close: 1, closed: 2, merged: 3 };

/** How long one `recv` waits before it asks again; a change waits as long as it takes. */
const RECV_SECONDS = 24 * 60 * 60;

/**
 * The next event on the change's topic within `timeoutSeconds`, or undefined for none; a message
 * that is no change event is skipped, with a warning.
 */
async function received(run: Run, timeoutSeconds: number): Promise<ChangeEvent | undefined> {
  for (;;) {
    const raw = await run.state.deadlines.waiting(run.id, { kind: "message" }, () =>
      DBOS.recv<unknown>(CHANGE_TOPIC, { timeoutSeconds }),
    );
    if (raw === null || raw === undefined) return undefined;
    const event = ChangeEventSchema.safeParse(raw);
    if (event.success) return event.data;
    warn(`run ${run.id}: a message on ${CHANGE_TOPIC} is no change event, so it is ignored`);
  }
}

/** Of `first` and the events waiting on the change's topic, read without waiting, the one that weighs most; undefined for none. */
async function drain(run: Run, first?: ChangeEvent): Promise<ChangeEvent | undefined> {
  let strongest = first;
  for (let event = await received(run, 0); event; event = await received(run, 0)) {
    if (strongest === undefined || WEIGHT[event.kind] > WEIGHT[strongest.kind]) strongest = event;
  }
  return strongest;
}

/**
 * Starts a run of the built-in `name` as a child of this one, with the id `<run>:<suffix>` (so a
 * replay finds it), as the run's own actor, and waits for its output, counted as a wait for
 * another run: undefined and the error's message when it failed.
 */
async function child(
  run: Run,
  name: string,
  suffix: string,
  input: unknown,
): Promise<{ runId: string; output?: unknown; error?: string }> {
  const runId = `${run.id}:${suffix}`;
  const handle = await run.state.startRun(name, runId, { input, startedBy: run.actor });
  try {
    return { runId, output: await run.state.deadlines.waiting(run.id, { kind: "run" }, () => handle.getResult()) };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return { runId, error: errorMessage(err) };
  }
}

/** A file's path relative to `root` with `/`, as git names it; undefined when it is outside. */
const pathIn = (root: string, file: string) =>
  inside(root, file) ? relative(root, file).split(sep).join("/") : undefined;

/** What `changeSteps` is given: the connectors' remote halves, and the declared hosts' ids, read from the data files. */
export interface ChangeStepsOptions {
  remotes: ReadonlyMap<string, RemoteHalf>;
  /** The resources the data files declare whose type is a host (`<file>#<export>`): none when no connector declares one. */
  hosts: () => Promise<string[]>;
}

/** The change workflow's steps for a config. */
export function changeSteps({ remotes, hosts }: ChangeStepsOptions): ChangeSteps {
  return {
    check: (id) =>
      DBOS.runStep(
        async (): Promise<CheckResult> => {
          const source = sourceOfRun();
          if (!source.check) throw new Error("This repository cannot check a draft (`Source.check`)");
          return source.check(id);
        },
        { name: "change:check" },
      ),

    plan: (id, check) =>
      DBOS.runStep(
        async (): Promise<ChangeFacts> => {
          const run = runNow();
          const source = sourceOfRun();
          if (!source.diff || !source.draft) throw new Error("This repository keeps no drafts (`Source.diff`)");
          const [{ files }, draft] = await Promise.all([source.diff(id), source.draft(id)]);
          const touches = touchesOf(files);
          const touched = new Set(touches);
          // The waiting runs of a workflow whose file the change edits, which a publish cannot move.
          const edited = [...run.state.workflows]
            .filter(([, wf]) => {
              const path = wf.file === undefined ? undefined : pathIn(source.root, wf.file);
              return path !== undefined && touched.has(path);
            })
            .map(([name]) => name);
          const pending = edited.length
            ? await DBOS.listWorkflows({
                status: "PENDING",
                workflowName: edited,
                applicationName: run.state.app,
                loadInput: false,
                loadOutput: false,
              })
            : [];
          const stranded = pending
            .map((r) => r.workflowID)
            .filter((runId) => runId !== run.id)
            .toSorted();
          // A people file as main has it or as the draft makes it: one added, edited or emptied.
          const people = await Promise.all(
            files
              .filter((file) => file.startsWith("resources/"))
              .flatMap((file) => [join(source.root, file), join(draft.root, file)].map(fileDeclaresPeople)),
          );
          return {
            touches,
            strandedRuns: stranded.length,
            stranded,
            checksOk: check.ok,
            rules: people.includes(true) || touches.some(isRules),
          };
        },
        { name: "change:plan" },
      ),

    ahead: (merge) =>
      DBOS.runStep(
        async (): Promise<ChangeDecision> => {
          const run = runNow();
          const op = run.state.ops.get(CHANGE_MERGE)!;
          const decision = await decide(run, op, op.input.parse(merge));
          if (decision.kind === "deny") return { answer: "deny", reason: decision.reason };
          if (decision.kind === "approve") {
            return {
              answer: "hold",
              approver: decision.approver,
              ...(decision.title !== undefined && { title: decision.title }),
              ...(decision.reasons !== undefined && { reasons: decision.reasons }),
            };
          }
          // Allowed: Publish is still someone's to press: whoever drafted it, else admin for an agent acting for no one.
          const { actor } = run;
          const drafter = actor.onBehalfOf ?? (actor.groups?.includes(AGENTS) ? undefined : actor.id);
          return { answer: "allow", approver: drafter ?? { group: ADMIN } };
        },
        { name: "change:policy" },
      ),

    async next() {
      const run = runNow();
      for (;;) {
        // An event comes from a request (`SanomaClient.changeEvent`), which wakes a stopped worker: no deadline.
        const event = await received(run, RECV_SECONDS);
        if (event) return (await drain(run, event)) ?? event;
      }
    },

    queued: () => drain(runNow()),

    retire: (reason) => withdrawApprovals(runNow(), CHANGE_MERGE, reason),

    async deploy() {
      const run = runNow();
      // The checkout moves to the merge first, so the hosts and what apply reads are the merged ones.
      const follow = await DBOS.runStep(
        async (): Promise<ChangeDeploy["follow"]> => {
          try {
            const { source, url, host } = await repositoryOf(remotes, run.state.secrets);
            if (!source.follow) return { skipped: "this repository cannot follow its remote" };
            const moved = await source.follow({ url, token: await host.token(), ref: "main" });
            return "revision" in moved ? { revision: moved.revision } : moved;
          } catch (err) {
            // Merged already: a deploy that fails is the change's to report, not a failed run.
            return { error: errorMessage(err) };
          }
        },
        { name: "change:follow" },
      );
      const declared = run.state.workflows.has(APPLY_WORKFLOW)
        ? await DBOS.runStep(hosts, { name: "change:hosts" })
        : [];
      if (!declared.length) return { follow };
      const { runId, error } = await child(run, APPLY_WORKFLOW, "deploy", { only: declared });
      return { follow, apply: { runId, hosts: declared, ...(error !== undefined && { error }) } };
    },

    settled: (number) =>
      DBOS.runStep(
        async (): Promise<ChangeEvent> => {
          const { host } = await repositoryOf(remotes, runNow().state.secrets);
          const pr = await host.pullRequest(number);
          if (pr.state === "merged") return { kind: "merged", sha: pr.mergeSha ?? pr.head };
          return pr.state === "closed" ? { kind: "closed" } : { kind: "commits" };
        },
        { name: "change:settled" },
      ),

    async verify({ apply }) {
      const run = runNow();
      if (apply === undefined || !run.state.workflows.has(DRIFT_WORKFLOW)) return undefined;
      const { runId, output, error } = await child(run, DRIFT_WORKFLOW, "verify", {});
      const applied = new Set(apply.hosts);
      const drifted = ((output as DriftReport | undefined)?.resources ?? [])
        .filter((r) => applied.has(r.id) && r.status !== "clean")
        .map((r) => r.id);
      return { runId, drifted, ...(error !== undefined && { error }) } satisfies ChangeVerified;
    },

    closeDraft: (id) => DBOS.runStep(async () => sourceOfRun().closeDraft?.(id), { name: "change:close-draft" }),

    publish: async (state: ChangeState) => {
      await DBOS.setEvent(CHANGE_EVENT, state);
    },
  };
}
