import { join, relative, sep } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { ApplyDeclared, ApplySteps, PlannedCall } from "./apply.ts";
import { decide } from "./call.ts";
import type { Approver } from "./define.ts";
import { type Binding, type Bindings, diffLockfiles, LOCKFILE, readLockfile, writeLockfile } from "./lockfile.ts";
import { currentRun, type Run } from "./run.ts";
import { APPLY_WORKFLOW } from "./shared.ts";

// The apply workflow's steps that call no vendor: reading the data files, asking the policy
// ahead, and writing the lockfile. Here, not in apply.ts, which is held to the workflow lint and
// imports no DBOS; each reads its run from `currentRun`.

/** The name of the step that writes the lockfile and commits it: its output has the bindings it wrote. */
const WRITE_STEP = "apply:lockfile";

/** How many of the latest apply runs are searched for the lockfile one last wrote. */
const RUNS_SEARCHED = 100;

const runNow = (): Run => {
  const run = currentRun.getStore();
  if (!run) throw new Error("An apply step ran outside its run");
  return run;
};

/**
 * The bindings the latest apply run that wrote the lockfile wrote last, from its steps; undefined
 * when none of the latest `RUNS_SEARCHED` did. A sandbox run writes none.
 */
async function lastWritten(appName: string): Promise<Bindings | undefined> {
  const runs = await DBOS.listWorkflows({
    workflowName: APPLY_WORKFLOW,
    applicationName: appName,
    sortDesc: true,
    limit: RUNS_SEARCHED,
    loadInput: false,
    loadOutput: false,
  });
  for (const { workflowID } of runs) {
    const steps = await DBOS.listWorkflowSteps(workflowID);
    const last = steps?.findLast((step) => step.name === WRITE_STEP && !step.error);
    if (last) return (last.output as { bindings: Bindings }).bindings;
  }
  return undefined;
}

/**
 * The apply workflow's steps for a config: `read`, the data files and the lockfile as drift reads
 * them, under `root`; `appName` scopes the search for the lockfile apply last wrote.
 */
export function applySteps(
  appName: string,
  root: string | undefined,
  read: () => Promise<Omit<ApplyDeclared, "rebinds">>,
): ApplySteps {
  return {
    // The data files, and the lockfile against the one apply last wrote: a change someone else made.
    declared: () =>
      DBOS.runStep(
        async () => {
          const declared = await read();
          const before = await lastWritten(appName);
          return { ...declared, rebinds: before ? diffLockfiles(before, declared.bindings) : [] };
        },
        { name: "apply:data-files" },
      ),
    // The policy asked as each call would ask it, now, so one approval can cover them all.
    holds: (calls: PlannedCall[]) =>
      DBOS.runStep(
        async (): Promise<Approver | undefined> => {
          const run = runNow();
          for (const { op: id, input } of calls) {
            const op = run.state.ops.get(id)!;
            // Parsed as the call will be, so the policy sees the same input with its defaults.
            const parsed = op.input.safeParse(input);
            const decision = await decide(run, op, parsed.success ? parsed.data : input);
            if (decision.kind === "approve") return decision.approver;
          }
          return undefined;
        },
        { name: "apply:policy" },
      ),
    // The one binding changed on the lockfile as it is now, written whole, then committed, in one
    // step whose output is what it wrote. A sandbox run keeps its lockfile in memory: the run's
    // report has it.
    write: async (key: string, binding: Binding | undefined, message: string) => {
      const run = runNow();
      if (run.sandbox !== undefined || root === undefined) return { written: false };
      const { source } = run.state;
      const { revision } = await DBOS.runStep(
        async (): Promise<{ bindings: Bindings; revision?: string }> => {
          const now = readLockfile(root);
          if (now.problems.length) throw new Error(`${LOCKFILE} cannot be updated: ${now.problems[0]!.message}`);
          const { [key]: _, ...others } = now.bindings;
          const bindings = binding ? { ...others, [key]: binding } : others;
          writeLockfile(root, bindings);
          const paths = [
            relative(source?.root ?? root, join(root, LOCKFILE))
              .split(sep)
              .join("/"),
          ];
          const committed = await source?.commit({ paths, message, author: run.actor.id });
          return { bindings, ...(committed && { revision: committed.revision }) };
        },
        { name: WRITE_STEP },
      );
      return { written: true, ...(revision !== undefined && { revision }) };
    },
  };
}
