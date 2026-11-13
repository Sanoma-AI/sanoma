import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { child, step } from "./app-steps.ts";
import { type ApprovalMessage, nextApprovalId, topicOf, withdrawApprovals } from "./approvals.ts";
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
  mayDeclarePeople,
  sourceOfRun,
  touchesOf,
} from "./change.ts";
import type { ChangeSteps } from "./change-workflow.ts";
import type { DriftReport } from "./drift.ts";
import { warn } from "./log.ts";
import { inside } from "./paths.ts";
import { peopleSources, readPeople } from "./resources.ts";
import { runNow, type Run } from "./run.ts";
import {
  AGENTS,
  APPLY_WORKFLOW,
  CHANGE_EVENT,
  CHANGE_MERGE,
  CHANGE_TOPIC,
  DRIFT_WORKFLOW,
  mayDecide,
} from "./shared.ts";
import type { RemoteHalf } from "./source.ts";

// The change workflow's steps that are not one of its operations: checking and planning the
// draft, asking the policy ahead, waiting for what happens to the change, retiring approvals,
// deploying and verifying after the merge, and publishing where the change is. Here, not in
// change-workflow.ts, which is held to the workflow lint and imports no DBOS; each reads its run
// from `currentRun`.

/** True when the file at `path` is a people file (`mayDeclarePeople`), one `readPeople` would load; false when there is none. */
const fileDeclaresPeople = async (path: string) => mayDeclarePeople(await readFile(path, "utf8").catch(() => ""));

/**
 * Whether a draft at `draft` whose change edits `files` (relative to the root) edits the rules, as
 * the planner's `rules` fact says: a policy or the template's people file by its path (`isRules`),
 * a people file as main at `root` has it or as the draft makes it (one added, edited or emptied),
 * or a file main's people are read from (a helper a people file imports).
 */
export async function editsRules(root: string, draft: string, files: readonly string[]): Promise<boolean> {
  const people = await Promise.all(
    files
      .filter((file) => file.startsWith("resources/"))
      .flatMap((file) => [join(root, file), join(draft, file)].map(fileDeclaresPeople)),
  );
  const sources = peopleSources(root);
  return people.includes(true) || touchesOf(files).some(isRules) || files.some((file) => sources.has(file));
}

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

/**
 * Of `first` and the events waiting on the change's topic, read without waiting, the one that
 * weighs most; undefined for none. A `merged` or `closed` someone told is checked on the host
 * (`settle`) as it is read, so a claim the pull request does not bear out weighs as `commits`.
 */
async function drain(
  run: Run,
  settle: () => Promise<ChangeEvent>,
  first?: ChangeEvent,
): Promise<ChangeEvent | undefined> {
  const checked = (event: ChangeEvent) => (event.kind === "merged" || event.kind === "closed" ? settle() : event);
  let strongest = first && (await checked(first));
  for (let event = await received(run, 0); event; event = await received(run, 0)) {
    const told = await checked(event);
    if (strongest === undefined || WEIGHT[told.kind] > WEIGHT[strongest.kind]) strongest = told;
  }
  return strongest;
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
  /** What the host says became of the pull request: merged or closed, else (still open) `commits`, to plan again. */
  const settled = (number: number) =>
    DBOS.runStep(
      async (): Promise<ChangeEvent> => {
        const { host } = await repositoryOf(remotes, runNow("A change step").state.secrets);
        const pr = await host.pullRequest(number);
        if (pr.state === "merged") return { kind: "merged", sha: pr.mergeSha ?? pr.head };
        return pr.state === "closed" ? { kind: "closed" } : { kind: "commits" };
      },
      { name: "change:settled" },
    );

  return {
    // In the box of whoever the change is by, through the app's steps: never on this instance.
    check: (id) => step(runNow("A change step"), "check", { id }, "change:check"),

    plan: (id, check) =>
      DBOS.runStep(
        async (): Promise<ChangeFacts> => {
          const run = runNow("A change step");
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
          return {
            touches,
            strandedRuns: stranded.length,
            stranded,
            checksOk: check.ok,
            rules: await editsRules(source.root, draft.root, files),
          };
        },
        { name: "change:plan" },
      ),

    ahead: (merge) =>
      DBOS.runStep(
        async (): Promise<ChangeDecision> => {
          const run = runNow("A change step");
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

    async next(number) {
      const run = runNow("A change step");
      for (;;) {
        // An event comes from a request (`SanomaClient.changeEvent`), which wakes a stopped worker: no deadline.
        const event = await received(run, RECV_SECONDS);
        if (event) return (await drain(run, () => settled(number), event))!;
      }
    },

    queued: (number) => drain(runNow("A change step"), () => settled(number)),

    retire: (reason) => withdrawApprovals(runNow("A change step"), CHANGE_MERGE, reason),

    async publishOnSave(approver) {
      const run = runNow("A change step");
      // As Publish's decision would be checked from the run's own actor, on the people declared now.
      const may = await DBOS.runStep(
        async () => {
          const { people, problems } = readPeople(run.state.root);
          return !problems.length && mayDecide({ approver }, run.actor, run, people);
        },
        { name: "change:saved" },
      );
      if (!may) return;
      // Publish is the run's next approval: its decision waits on its topic until it is asked.
      const decision: ApprovalMessage = { decision: "approve", by: run.actor, note: "Saved" };
      await DBOS.send(run.id, decision, topicOf(nextApprovalId(run)));
    },

    async deploy() {
      const run = runNow("A change step");
      // The checkout moves to the merge first, so the hosts and what apply reads are the merged ones.
      // Merged already: a deploy that fails is the change's to report, not a failed run.
      const follow: ChangeDeploy["follow"] = await DBOS.runStep(() => run.state.followMain(), {
        name: "change:follow",
      });
      const declared = run.state.workflows.has(APPLY_WORKFLOW)
        ? await DBOS.runStep(hosts, { name: "change:hosts" })
        : [];
      if (!declared.length) return { follow };
      const { runId, error } = await child(run, APPLY_WORKFLOW, "deploy", { only: declared });
      return { follow, apply: { runId, hosts: declared, ...(error !== undefined && { error }) } };
    },

    async verify({ apply }) {
      const run = runNow("A change step");
      if (apply === undefined || !run.state.workflows.has(DRIFT_WORKFLOW)) return undefined;
      const { runId, output, error } = await child(run, DRIFT_WORKFLOW, "verify", {});
      const applied = new Set(apply.hosts);
      const read = ((output as DriftReport | undefined)?.resources ?? []).filter((r) => applied.has(r.id));
      // A host drift could not read is no drift: it is said in `error`.
      const drifted = read.filter((r) => r.status !== "clean" && r.status !== "error").map((r) => r.id);
      const unread = read.filter((r) => r.status === "error").map((r) => r.id);
      const errors = [error, ...(unread.length ? [`could not read ${unread.join(", ")}`] : [])].filter(
        (e) => e !== undefined,
      );
      return { runId, drifted, ...(errors.length && { error: errors.join("; ") }) } satisfies ChangeVerified;
    },

    closeDraft: (id) => DBOS.runStep(async () => sourceOfRun().closeDraft?.(id), { name: "change:close-draft" }),

    publish: async (state: ChangeState) => {
      await DBOS.setEvent(CHANGE_EVENT, state);
    },
  };
}
