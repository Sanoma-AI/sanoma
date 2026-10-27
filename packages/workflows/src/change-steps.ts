import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { withdrawApprovals } from "./approvals.ts";
import { decide } from "./call.ts";
import {
  type ChangeDecision,
  type ChangeEvent,
  ChangeEventSchema,
  type ChangeFacts,
  type ChangeDeploy,
  type ChangeState,
  type ChangeVerified,
  repositoryOf,
  touchesOf,
} from "./change.ts";
import type { ChangeSteps } from "./change-workflow.ts";
import type { DriftReport } from "./drift.ts";
import { isRunControlError } from "./errors.ts";
import { warn } from "./log.ts";
import { DECLARES_PEOPLE } from "./resources.ts";
import { currentRun, type Run, type RunArgs } from "./run.ts";
import {
  AGENTS,
  APPLY_WORKFLOW,
  CHANGE_EVENT,
  CHANGE_MERGE,
  CHANGE_TOPIC,
  DRIFT_WORKFLOW,
  errorMessage,
} from "./shared.ts";
import type { CheckResult, RemoteHalf, Source } from "./source.ts";

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

/** The worker's repository, as a step that needs no host reads it. */
function sourceOf(run: Run): Source {
  const { source } = run.state;
  if (!source) throw new Error("This worker was given no repository (`source`), so it cannot change one");
  return source;
}

/** A path under `root`, relative to it with `/`, as git names it; undefined when it is outside. */
function inside(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  return rel === "" || rel.startsWith("..") || rel.startsWith(sep) ? undefined : rel.split(sep).join("/");
}

/** True when the file at `path` is a people file (`DECLARES_PEOPLE`): one `readPeople` would read. */
const declaresPeople = (path: string) => existsSync(path) && DECLARES_PEOPLE.test(readFileSync(path, "utf8"));

/** Which events win when several wait: one that ends the change over one that plans it again. */
const WEIGHT: Record<ChangeEvent["kind"], number> = { commits: 0, close: 1, closed: 2, merged: 3 };

/** How long one `recv` waits before it asks again; a change waits as long as it takes. */
const RECV_SECONDS = 24 * 60 * 60;

/** The change's events waiting on its topic, read without waiting: the one that weighs most, or undefined for none. */
async function drain(run: Run, first?: ChangeEvent): Promise<ChangeEvent | undefined> {
  let strongest = first;
  for (;;) {
    const raw = await run.state.deadlines.waiting(run.id, { kind: "message" }, () =>
      DBOS.recv<unknown>(CHANGE_TOPIC, { timeoutSeconds: 0 }),
    );
    if (raw === null || raw === undefined) return strongest;
    const event = parsed(run, raw);
    if (event && (strongest === undefined || WEIGHT[event.kind] > WEIGHT[strongest.kind])) strongest = event;
  }
}

/** The event a message is, or undefined (with a warning) for one that is not. */
function parsed(run: Run, raw: unknown): ChangeEvent | undefined {
  const event = ChangeEventSchema.safeParse(raw);
  if (!event.success) warn(`run ${run.id}: a message on ${CHANGE_TOPIC} is no change event, so it is ignored`);
  return event.data;
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
  const fn = run.state.registered.get(name);
  if (!fn) throw new Error(`The worker has no workflow "${name}" to start`);
  const runId = `${run.id}:${suffix}`;
  const args: RunArgs = { input, startedBy: run.actor };
  const handle = await DBOS.startWorkflow(fn, { workflowID: runId })(args);
  try {
    const output = await run.state.deadlines.waiting(run.id, { kind: "run", id: runId }, () => handle.getResult());
    return { runId, output };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return { runId, error: errorMessage(err) };
  }
}

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
          const source = sourceOf(runNow());
          if (!source.check) throw new Error("This repository cannot check a draft (`Source.check`)");
          return source.check(id);
        },
        { name: "change:check" },
      ),

    plan: (id, check) =>
      DBOS.runStep(
        async (): Promise<ChangeFacts> => {
          const run = runNow();
          const source = sourceOf(run);
          if (!source.diff || !source.draft) throw new Error("This repository keeps no drafts (`Source.diff`)");
          const { files } = await source.diff(id);
          const touches = touchesOf(files);
          // The waiting runs whose workflow's file the change edits, which a publish cannot move.
          const pending = await DBOS.listWorkflows({
            status: "PENDING",
            applicationName: run.state.app,
            loadInput: false,
            loadOutput: false,
          });
          const stranded = pending
            .filter(({ workflowID, workflowName }) => {
              const file = run.state.workflows.get(workflowName)?.file;
              const path = file === undefined ? undefined : inside(source.root, file);
              return workflowID !== run.id && path !== undefined && touches.includes(path);
            })
            .map((r) => r.workflowID)
            .toSorted();
          // A people file as main has it or as the draft makes it: one added, edited or emptied.
          const draft = (await source.draft(id)).root;
          const people = files.some(
            (file) =>
              file.startsWith("resources/") &&
              (declaresPeople(join(source.root, file)) || declaresPeople(join(draft, file))),
          );
          return {
            touches,
            strandedRuns: stranded.length,
            stranded,
            checksOk: check.ok,
            rules: people || touches.includes("policies/"),
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
          return { answer: "allow", approver: drafter ?? { group: "admin" } };
        },
        { name: "change:policy" },
      ),

    async next() {
      const run = runNow();
      for (;;) {
        // An event comes from a request (`SanomaClient.changeEvent`), which wakes a stopped worker: no deadline.
        const raw = await run.state.deadlines.waiting(run.id, { kind: "message" }, () =>
          DBOS.recv<unknown>(CHANGE_TOPIC, { timeoutSeconds: RECV_SECONDS }),
        );
        const event = raw === null || raw === undefined ? undefined : parsed(run, raw);
        if (event) return (await drain(run, event))!;
      }
    },

    queued: () => drain(runNow()),

    retire: (reason) => withdrawApprovals(runNow(), CHANGE_MERGE, reason),

    async deploy() {
      const run = runNow();
      const declared = run.state.workflows.has(APPLY_WORKFLOW)
        ? await DBOS.runStep(hosts, { name: "change:hosts" })
        : [];
      if (declared.length) {
        const { runId, error } = await child(run, APPLY_WORKFLOW, "deploy", { only: declared });
        return { runId, hosts: declared, ...(error !== undefined && { error }) } satisfies ChangeDeploy;
      }
      // No host: this checkout is the live instance, fast-forwarded to the merge.
      return DBOS.runStep(
        async (): Promise<ChangeDeploy> => {
          const { source, url, host } = await repositoryOf(remotes, run.state.secrets);
          if (!source.follow) return { skipped: "this repository cannot follow its remote" };
          const followed = await source.follow({ url, token: await host.token(), ref: "main" });
          return "revision" in followed ? { followed: followed.revision } : { skipped: followed.skipped };
        },
        { name: "change:follow" },
      );
    },

    async verify(deploy) {
      const run = runNow();
      if (deploy.runId === undefined || !run.state.workflows.has(DRIFT_WORKFLOW)) return undefined;
      const { runId, output, error } = await child(run, DRIFT_WORKFLOW, "verify", {});
      const applied = new Set(deploy.hosts);
      const drifted = ((output as DriftReport | undefined)?.resources ?? [])
        .filter((r) => applied.has(r.id) && r.status !== "clean")
        .map((r) => r.id);
      return { runId, drifted, ...(error !== undefined && { error }) } satisfies ChangeVerified;
    },

    closeDraft: (id) => DBOS.runStep(async () => sourceOf(runNow()).closeDraft?.(id), { name: "change:close-draft" }),

    publish: async (state: ChangeState) => {
      await DBOS.setEvent(CHANGE_EVENT, state);
    },
  };
}
