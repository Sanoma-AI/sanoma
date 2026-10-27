import { z } from "zod";
import type { ApprovalState, Approver } from "./define.ts";
import { type CallContext, defineConnector, defineDriver, type Driver, DriverError } from "./op.ts";
import { approve, approvedFor, type Decision, deny } from "./policy.ts";
import { isChangeOp, type Resource } from "./resource.ts";
import { currentRun } from "./run.ts";
import type { Secrets } from "./secret.ts";
import { APPLY_WORKFLOW, CHANGE_MERGE, CHANGE_WORKFLOW, groupNamesOf, type PeopleResource } from "./shared.ts";
import {
  type CheckResult,
  type RemoteContext,
  type RemoteHalf,
  remoteFor,
  type Source,
  type SourceHost,
} from "./source.ts";

// A change: how a draft of the company's repository goes live, as the built-in `change` workflow
// runs it (`change-workflow.ts`): its four operations on the built-in connector `sanoma` and their
// driver over the repository's host, the facts a policy decides its merge on (the attributes of
// its `Sanoma::Change`), and the runtime's own rule that a change to the rules waits for `admin`,
// before any company policy is asked.

/**
 * What the planner finds in a change, before the policy is asked: the attributes of the
 * `Sanoma::Change` that `sanoma.change.merge` acts on, so a rule reads `resource.touches`.
 */
export const ChangeFacts = z.object({
  /** Every path the change edits and each of its parent directories (`touchesOf`). */
  touches: z.array(z.string()),
  /** How many waiting runs are of a workflow the change edits, which the publish cannot move. */
  strandedRuns: z.number().int(),
  /** Those runs' ids. */
  stranded: z.array(z.string()),
  /** Whether `sanoma check` passed on the change. */
  checksOk: z.boolean(),
  /** Whether the change edits the rules: a policy (the root's or an app's) or a people file, which wait for `admin` (`runtimeHold`). */
  rules: z.boolean(),
});
export type ChangeFacts = z.infer<typeof ChangeFacts>;

/** What opening a change takes: its draft's id, and the pull request's title, body and the change page's link. */
export const ChangeInput = z.object({
  id: z.string().regex(/^[\w-]{1,64}$/),
  title: z.string().min(1),
  body: z.string().optional(),
  page: z.string().url().optional(),
});
export type ChangeInput = z.infer<typeof ChangeInput>;

/** The change a call acts on: its policy target. */
const target = ({ id }: { id: string }) => `change:${id}`;
/** A change once it has a pull request: its draft's id and the pull request's number. */
const opened = { id: ChangeInput.shape.id, number: z.number().int().positive() };

/** The operations of a change, on the built-in connector `sanoma`: only the `change` workflow calls them. */
export const changeOps = defineConnector("sanoma", {
  change: {
    open: {
      effect: "write",
      idempotent: true,
      description: "Open a change: push its draft's branch and open a pull request for it",
      input: ChangeInput,
      output: z.object({ number: z.number().int(), url: z.string(), head: z.string(), branch: z.string() }),
      target,
      phrases: { expect: "change {id} is opened" },
    },
    review: {
      effect: "write",
      idempotent: true,
      description: "Report Sanoma's review of a change on its pull request",
      input: z.object({
        ...opened,
        head: z.string(),
        state: z.enum(["pending", "failure"]),
        description: z.string(),
        page: z.string().url().optional(),
      }),
      output: z.object({}),
      target,
      phrases: { expect: "change {id} is reviewed" },
    },
    merge: {
      effect: "write",
      idempotent: true,
      description: "Merge a change's pull request",
      input: z.object({ ...opened, head: z.string(), title: z.string(), facts: ChangeFacts }),
      output: z.object({
        outcome: z.enum(["merged", "closed", "moved", "blocked"]),
        sha: z.string().optional(),
        reason: z.string().optional(),
      }),
      target,
      phrases: { expect: "change {id} is merged" },
    },
    close: {
      effect: "write",
      idempotent: true,
      description: "Close a change's pull request without merging it",
      input: z.object(opened),
      output: z.object({ closed: z.literal(true) }),
      target,
      phrases: { expect: "change {id} is closed" },
    },
  },
});

/**
 * The built-in workflow that alone may call `op`, what the operation does and what to do instead:
 * `apply` for a writable resource type's change operations (`isChangeOp`), `change` for
 * `sanoma.change.*`; undefined for any other. `resolveConfig` refuses a workflow that uses one, and
 * a run's call of one outside its workflow fails.
 */
export function reservedFor(
  op: { readonly vendor: string; readonly resource: string; readonly name: string },
  types: ReadonlyMap<string, Pick<Resource, "writable">>,
): { workflow: string; does: string; instead: string } | undefined {
  if (isChangeOp(op, types)) {
    return { workflow: APPLY_WORKFLOW, does: "changes a declared resource", instead: "change the data file" };
  }
  if (op.vendor === "sanoma" && op.resource === "change") {
    return { workflow: CHANGE_WORKFLOW, does: "changes the company's repository", instead: "send a draft for review" };
  }
  return undefined;
}

/** The branch a change merges into. */
const BASE = "main";

/** Who reads the company's credentials for a host: the environment's first, then the stored ones, as a login half does. */
export const remoteContext = (secrets: Secrets): RemoteContext => ({
  async secrets(names) {
    const found = await Promise.all(
      names.map(async (name) => [name, process.env[name] || (await secrets.get(name))] as const),
    );
    return new Map(found.filter((entry): entry is readonly [string, string] => Boolean(entry[1])));
  },
});

/**
 * The worker's repository and its host, for a call made in a run (a change's driver and its
 * steps): the source the worker was given, the clone URL of its `origin` and that repository on
 * the host whose connector's remote half matches the URL, opened once for the call so its token
 * is minted once. A `DriverError` when the worker has no source, when the repository has no remote
 * (saving is publishing then: there is nothing to review a branch on) or no connector is for its host.
 */
export async function repositoryOf(
  remotes: ReadonlyMap<string, RemoteHalf>,
  secrets: Secrets,
): Promise<{ source: Source; url: string; host: SourceHost }> {
  const source = currentRun.getStore()?.state.source;
  if (!source) {
    throw new DriverError("This worker was given no repository (`source`), so it cannot change one", {
      retryable: false,
    });
  }
  const url = await source.remoteUrl?.();
  if (!url) {
    throw new DriverError("saving is publishing: this repository has no remote", {
      retryable: false,
      vendorCode: "no_remote",
    });
  }
  const found = remoteFor(remotes, url);
  if (!found) {
    throw new DriverError(`No connector's remote half is for ${url}: add the connector of its host`, {
      retryable: false,
      vendorCode: "no_remote_half",
    });
  }
  return { source, url, host: found.remote.open(found.repo, remoteContext(secrets)) };
}

/** The `DriverError` code a host gave, read by property: the error may come from another copy of the package. */
const vendorCodeOf = (err: unknown) => (err as { vendorCode?: unknown } | null)?.vendorCode;

/**
 * The driver of a change's operations, over the repository the worker was given (`source`, read
 * from the run) and its host (`remotes`, the connectors' remote halves: `remoteFor` its
 * `origin`). Each call opens the host once, so its token is minted once.
 *
 * - `open` pushes the draft's branch and opens its pull request into `main` (the open one when it
 *   has one): safe to retry. Its `head` is the branch's commit as pushed.
 * - `review` sets the `sanoma` status on the head, linking to the change page: `pending`, or
 *   `failure`; never `success`, which only a merge sets.
 * - `merge` reads the pull request: merged already (a retry whose answer was lost) or closed are
 *   answered as they are; a branch at another commit than `head`, on the host or in the draft, is
 *   `moved`. Else it sets the status `success` and squash-merges at `head`: the host's `head_moved`
 *   is `moved`, `not_mergeable` is `blocked` with the host's reason. The branch is then deleted,
 *   as far as it can be.
 * - `close` closes the pull request.
 */
export function changeDriver(remotes: ReadonlyMap<string, RemoteHalf>): Driver {
  const open = (call: CallContext) => repositoryOf(remotes, call.secrets);
  return defineDriver(changeOps, {
    change: {
      async open({ id, title, body }, call) {
        const { source, url, host } = await open(call);
        if (!source.draft || !source.drafts || !source.push) {
          throw new DriverError("This repository keeps no drafts, so it has no change to open", { retryable: false });
        }
        if (!(await source.drafts()).includes(id)) {
          throw new DriverError(`There is no open draft "${id}" to send for review`, {
            retryable: false,
            vendorCode: "no_draft",
          });
        }
        const { branch } = await source.draft(id);
        await source.push({ url, token: await host.token(), ref: branch });
        const head = await source.head(branch);
        const pr = await host.openPullRequest({ branch, base: BASE, title, body: body ?? "" });
        return { number: pr.number, url: pr.url, head, branch };
      },
      async review({ head, state, description, page }, call) {
        const { host } = await open(call);
        await host.setStatus({ sha: head, state, description, ...(page !== undefined && { targetUrl: page }) });
        return {};
      },
      async merge({ number, head, title }, call) {
        const { source, host } = await open(call);
        const pr = await host.pullRequest(number);
        if (pr.state === "merged")
          return { outcome: "merged" as const, ...(pr.mergeSha !== undefined && { sha: pr.mergeSha }) };
        if (pr.state === "closed") return { outcome: "closed" as const };
        // Commits the run has not planned: pushed to the host, or made in the draft and not pushed yet.
        const local = await Promise.resolve(source.head(pr.branch)).catch(() => undefined);
        if (pr.head !== head || (local !== undefined && local !== head)) return { outcome: "moved" as const };
        await host.setStatus({ sha: head, state: "success", description: "Published through Sanoma" });
        let sha: string;
        try {
          ({ sha } = await host.mergePullRequest(number, {
            sha: head,
            method: "squash",
            title: `${title} (#${number})`,
          }));
        } catch (err) {
          // Not merged: Sanoma's status on the head goes back to failing, so the host does not merge it either.
          const reason = (err as Error).message;
          await host
            .setStatus({ sha: head, state: "failure", description: `Not published: ${reason}`.slice(0, 140) })
            .catch(() => undefined);
          const code = vendorCodeOf(err);
          if (code === "head_moved") return { outcome: "moved" as const };
          if (code === "not_mergeable") return { outcome: "blocked" as const, reason };
          throw err;
        }
        // Best effort: a branch left behind holds nothing the merge did not take.
        await host.deleteBranch?.(pr.branch).catch(() => undefined);
        return { outcome: "merged" as const, sha };
      },
      async close({ number }, call) {
        const { host } = await open(call);
        await host.closePullRequest(number);
        return { closed: true as const };
      },
    },
  });
}

/**
 * Each path, relative to the root with `/` between its parts, and each of its parent directories
 * with a trailing `/`, sorted, each once: what a rule asks with `touches.contains("resources/finance/")`.
 */
export function touchesOf(files: readonly string[]): string[] {
  const touches = new Set<string>();
  for (const file of files) {
    touches.add(file);
    for (let end = file.indexOf("/"); end > 0; end = file.indexOf("/", end + 1)) touches.add(file.slice(0, end + 1));
  }
  return [...touches].toSorted();
}

/** The group the runtime holds a change to the rules for. */
export const ADMIN = "admin";
/**
 * Whether a path in `touches` is the rules whatever `rules` says: the policies, the root's or an
 * app's (`apps/crm/policies/`), and the template's people file.
 */
const isRules = (path: string) =>
  path === "policies/" || path === "resources/people.ts" || /^apps\/[^/]+\/policies\/$/.test(path);
/** The runtime rule's id, as a hold's `reasons` name it. */
const RULES_WAIT_FOR_ADMIN = "sanoma:rules-wait-for-admin";

/**
 * The runtime's own rule, asked before any company policy and under `allowAll` too: a merge of a
 * change to the rules (`facts.rules`, or `touches` naming `policies/`, an app's `policies/` or
 * `resources/people.ts`) waits for `admin`, whoever made it, until an approval
 * addressed to `admin` covering the merge is approved; denied while no data file declares the
 * group. Undefined for anything else, which the company's policy alone decides. `people` are the
 * running instance's, never the change's, so a change cannot add its author to `admin`.
 */
export function runtimeHold(
  opId: string,
  input: unknown,
  approvals: readonly ApprovalState[],
  people: readonly PeopleResource[],
): Decision | undefined {
  const facts = opId === CHANGE_MERGE ? (input as { facts?: ChangeFacts }).facts : undefined;
  // The planner's `rules`, or what `touches` already says: a fact left false cannot skip the rule.
  if (!facts || !(facts.rules || facts.touches.some(isRules))) return undefined;
  if (!groupNamesOf(people).includes(ADMIN)) {
    return deny(
      `A change to the policies or the people waits for the group "${ADMIN}", which no data file declares: ` +
        `declare it in resources/people.ts`,
      [RULES_WAIT_FOR_ADMIN],
    );
  }
  const approver: Approver = { group: ADMIN };
  if (approvedFor(approvals, CHANGE_MERGE, approver)) return undefined;
  return approve(approver, { title: "A change to the rules waits for admin", reasons: [RULES_WAIT_FOR_ADMIN] });
}

/**
 * What a change run is told (on `CHANGE_TOPIC`): new commits on its branch, a close someone asked
 * for, or its pull request closed or merged on the host.
 */
export type ChangeEvent =
  | { kind: "commits" }
  | { kind: "close"; by: string }
  | { kind: "closed" }
  | { kind: "merged"; sha: string };

/** A `ChangeEvent`, as a run reads one off its topic. */
export const ChangeEventSchema: z.ZodType<ChangeEvent> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commits") }),
  z.object({ kind: z.literal("close"), by: z.string().min(1) }),
  z.object({ kind: z.literal("closed") }),
  z.object({ kind: z.literal("merged"), sha: z.string().min(1) }),
]);

/** What a merge is asked with: the change, its pull request at the head planned, and the facts. */
export type MergeInput = z.input<typeof changeOps.change.merge.input>;

/**
 * The policy's answer to a change's merge, asked ahead (`ChangeState.decision`): `allow`, `hold`
 * for the approver and title the policy gave, or `deny` with its reason. An allowed or held change
 * has an `approver`, whose approval is Publish: the hold's, else whoever drafted it.
 */
export type ChangeDecision = NonNullable<ChangeState["decision"]>;

/** What became of the deploy after a merge: the apply run started on the declared hosts, or the laptop's `main` fast-forwarded (`followed`) or not (`skipped`, why). */
export interface ChangeDeploy {
  /** The apply run started on the hosts, and its error when it failed. */
  runId?: string;
  error?: string;
  /** The declared hosts' ids (`<file>#<export>`) the apply run was restricted to. */
  hosts?: string[];
  /** The revision the checkout was fast-forwarded to, with no host declared. */
  followed?: string;
  skipped?: string;
}

/** The drift run that read the hosts back after their apply, and the hosts it found not as declared. */
export interface ChangeVerified {
  runId: string;
  drifted: string[];
  error?: string;
}

/** Where a change is, as its run publishes it (`CHANGE_EVENT`) for the app. */
export interface ChangeState {
  id: string;
  branch: string;
  title: string;
  page?: string;
  phase:
    | "opening"
    | "planning"
    | "checking"
    | "reviewing"
    | "waiting"
    | "merging"
    | "deploying"
    | "merged"
    | "closed"
    | "blocked";
  pullRequest?: { number: number; url: string };
  head?: string;
  facts?: ChangeFacts;
  check?: CheckResult;
  decision?: {
    answer: "allow" | "hold" | "deny";
    approver?: Approver;
    title?: string;
    reasons?: string[];
    reason?: string;
  };
  /** The review card on the host: unavailable in this version. */
  card: { status: "unavailable"; reason: string };
  merged?: { sha: string; at: number; deploy?: ChangeDeploy; verified?: ChangeVerified };
  /** Why the change cannot merge now: the policy denies it, or the host refuses the merge. */
  blocked?: string;
  /** Who closed it, when someone asked (a `close` event, or a rejection of the Publish approval). */
  closedBy?: string;
}

/** How a change run ended. */
export interface ChangeReport {
  outcome: "merged" | "closed";
  head: string;
  pullRequest: { number: number; url: string };
  sha?: string;
  deploy?: ChangeDeploy;
  verified?: ChangeVerified;
}
