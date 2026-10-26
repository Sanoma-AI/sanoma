import { z } from "zod";
import type { ApprovalState, Approver } from "./define.ts";
import { defineConnector, defineDriver, type Driver, DriverError } from "./op.ts";
import { approve, approvedFor, type Decision, deny } from "./policy.ts";
import { isChangeOp, type Resource } from "./resource.ts";
import { APPLY_WORKFLOW, CHANGE_MERGE, CHANGE_WORKFLOW, groupNamesOf, type PeopleResource } from "./shared.ts";
import type { CheckResult } from "./source.ts";

// A change: how a draft of the company's repository goes live, as the built-in `change` workflow
// runs it (lane C5): its four operations on the built-in connector `sanoma`, the facts a policy
// decides its merge on (the attributes of its `Sanoma::Change`), and the runtime's own rule that
// a change to the rules waits for `admin`, before any company policy is asked.

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

const notBuilt = async (): Promise<never> => {
  throw new DriverError("not built", { retryable: false });
};

/** A placeholder: lane C5 replaces it with the driver over the repository's host. */
export function changeDriver(): Driver {
  return defineDriver(changeOps, { change: { open: notBuilt, review: notBuilt, merge: notBuilt, close: notBuilt } });
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
const ADMIN = "admin";
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

/** What a change run is told while it waits: new commits on its branch, a close asked for, or its pull request closed or merged on the host. */
export type ChangeEvent =
  | { kind: "commits" }
  | { kind: "close"; by: string }
  | { kind: "closed" }
  | { kind: "merged"; sha: string };

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
  merged?: { sha: string; at: number; deploy?: { runId?: string; followed?: string; skipped?: string } };
  blocked?: string;
}

/** How a change run ended. */
export interface ChangeReport {
  outcome: "merged" | "closed";
  head: string;
  pullRequest: { number: number; url: string };
  sha?: string;
  deploy?: { runId?: string };
}
