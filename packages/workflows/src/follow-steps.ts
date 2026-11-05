import { DBOS } from "@dbos-inc/dbos-sdk";
import { BASE, type ChangeEvent, followBase, repositoryOf } from "./change.ts";
import { errorCode, vendorCodeOf } from "./errors.ts";
import type { FollowOutput, FollowSteps, FollowTarget } from "./follow-workflow.ts";
import { warn } from "./log.ts";
import { currentRun, type Run } from "./run.ts";
import { APPLY_WORKFLOW, HOST_CHECK_AGENT, isEnded } from "./shared.ts";
import { draftOf, type RemoteHalf, type RepoRef } from "./source.ts";

// The follow workflow's steps (`follow-workflow.ts` is held to the workflow lint and imports no
// DBOS): where an event lands, `main` followed and its hosts applied, a draft's change told what
// its host says. Each reads its run from `currentRun`; the worker's own client tells and reads
// the changes, as `host-check`, and every write to the checkout is one of the worker's, one at a
// time (`WorkerState.serially`).

const runNow = (): Run => {
  const run = currentRun.getStore();
  if (!run) throw new Error("A follow step ran outside its run");
  return run;
};

/** Whether two references name one repository: a host's names are compared without case. */
const sameRepo = (a: RepoRef, b: RepoRef) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

/** What the follow steps need of the resolved config: the remote halves and the declared hosts. */
export interface FollowStepsOptions {
  remotes: ReadonlyMap<string, RemoteHalf>;
  hosts(): Promise<string[]>;
}

export function followSteps({ remotes, hosts }: FollowStepsOptions): FollowSteps {
  /** The worker's repository on its host (`repositoryOf`); undefined with no repository, remote or half for it. */
  const repository = async (run: Run) => {
    const { source } = run.state;
    if (!source) return undefined;
    return repositoryOf(remotes, run.state.secrets, source).catch((err: unknown) => {
      if (["no_remote", "no_remote_half"].includes(vendorCodeOf(err) ?? "")) return undefined;
      throw err;
    });
  };

  return {
    where: (event) =>
      DBOS.runStep(
        async (): Promise<FollowTarget> => {
          const main = event.kind === "pushed" && event.branch === BASE;
          const id = draftOf(event.branch);
          if (!main && id === undefined) return { ignored: `${event.branch} is neither ${BASE} nor a draft's branch` };
          const run = runNow();
          if (!run.state.source) return { ignored: "This worker has no repository" };
          const found = await repository(run);
          if (!found) return { ignored: "This worker's repository has no remote on a host a connector reads" };
          if (!sameRepo(found.repo, event.repo)) {
            return { ignored: `The event is ${event.repo.owner}/${event.repo.name}'s, not this repository's` };
          }
          return event.kind === "pushed" && main ? { main: event.head } : { draft: id! };
        },
        { name: "follow:where" },
      ),

    async main(head) {
      const run = runNow();
      const deploy = `deploy:${head}`;
      const declared = await DBOS.runStep(
        async () => {
          const client = await run.state.client();
          const [deployed, open] = await Promise.all([
            client.run(deploy),
            client.changes({ open: true, limit: Number.POSITIVE_INFINITY }),
          ]);
          if (deployed || open.some((c) => c.state.phase === "merging" || c.state.phase === "deploying")) {
            return undefined;
          }
          // First, as a change's deploy does: the hosts, and what apply reads, are then main's.
          const moved = await run.state.serially(() => followBase(remotes, run.state.secrets, run.state.source));
          if (!("revision" in moved)) {
            // Nothing recorded as `deploy:<head>`: a later push deploys it.
            throw new Error(
              `${BASE} was not deployed: the checkout did not follow it: ${"skipped" in moved ? moved.skipped : moved.error}`,
            );
          }
          run.state.refreshAppsBehind();
          return run.state.workflows.has(APPLY_WORKFLOW) ? await hosts() : [];
        },
        { name: "follow:main" },
      );
      if (!declared) return { ignored: `${deploy} has run, or a change is deploying ${BASE}` };
      if (!declared.length) return { followed: "main" } satisfies FollowOutput;
      // As the run's own actor, `host-check` (`SanomaClient.follow`).
      await run.state.startRun(APPLY_WORKFLOW, deploy, { input: { only: declared }, startedBy: run.actor });
      return { followed: "main", deploy };
    },

    draft: (event, id) =>
      DBOS.runStep(
        async (): Promise<{ told: ChangeEvent; key: string } | { ignored: string }> => {
          const run = runNow();
          const change = await (await run.state.client()).change(id);
          if (!change || isEnded(change.status)) return { ignored: `The draft ${id} has no open change` };
          const key = `${event.kind}:${event.branch}:`;
          if (event.kind === "closed") {
            // A pull request of an earlier change of the draft is not this one's.
            if (event.number !== change.state.pullRequest?.number) {
              return { ignored: `Pull request #${event.number} is not the open change's` };
            }
            return {
              told: event.merged && event.sha !== undefined ? { kind: "merged", sha: event.sha } : { kind: "closed" },
              key: `${key}${event.number}:${event.sha ?? "closed"}`,
            };
          }
          if (change.state.head === event.head) return { ignored: `The change is at ${event.head} already` };
          const found = await repository(run);
          if (!found?.source.follow) return { ignored: "This repository cannot follow its remote" };
          const { source, url, host } = found;
          const fetched = await run.state.serially(async () => {
            const local = await Promise.resolve(source.head(event.branch)).catch(() => undefined);
            if (local === event.head) return false;
            const moved = await source.follow!({ url, token: await host.token(), ref: event.branch });
            if ("skipped" in moved) warn(`${event.branch} did not take the host's commits: ${moved.skipped}`);
            return !("skipped" in moved);
          });
          if (!fetched) return { ignored: `${event.branch} holds ${event.head} already, or cannot take it` };
          return { told: { kind: "commits" }, key: `${key}${event.head}` };
        },
        { name: "follow:draft" },
      ),

    tell: (id, told, key) =>
      DBOS.runStep(
        async () => {
          const client = await runNow().state.client();
          await client.changeEvent(id, told, { by: HOST_CHECK_AGENT, key }).catch((err: unknown) => {
            // Ended, or gone, since it was read: nothing to tell.
            if (!["run_ended", "run_not_found"].includes(errorCode(err) ?? "")) throw err;
          });
        },
        { name: "follow:tell" },
      ),
  };
}
