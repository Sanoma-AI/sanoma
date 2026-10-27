import type { Approver } from "@sanoma-ai/workflows";
import type { ChangeFacts, ChangeState } from "@sanoma-ai/workflows/shared";

// A change's words and groups for its pages (`routes/changes/`), the Inbox's glance and the run
// page, without React: in the ops manager's words, the branch and the pull request underneath.

/** Who an approval waits for, as a sentence names them: a person's id, a group's name. */
export const approverName = (approver: Approver) => (typeof approver === "string" ? approver : approver.group);

/** Where a change is, in a word or two: Publish waiting names its approver; merged is Published. */
export function phaseLabel(state: Pick<ChangeState, "phase" | "decision">): string {
  switch (state.phase) {
    case "waiting":
      return state.decision?.approver ? `Waiting for ${approverName(state.decision.approver)}` : "Waiting";
    case "merged":
      return "Published";
    default:
      return state.phase[0]!.toUpperCase() + state.phase.slice(1);
  }
}

/** The rule behind the policy's answer to a change's merge: its title, else its ids. */
export const ruleOf = (decision: ChangeState["decision"]) => decision?.title ?? decision?.reasons?.join(", ");

/** True once a change can no longer move: merged or closed. */
export const isSettled = (state: Pick<ChangeState, "phase">) => state.phase === "merged" || state.phase === "closed";

/** The files a change edits: its `touches` without their parent directories. */
export const filesOf = (facts: Pick<ChangeFacts, "touches"> | undefined): string[] =>
  facts?.touches.filter((path) => !path.endsWith("/")) ?? [];

/** A group of a change's files, by what they are to the company. */
export interface FileGroup {
  key: string;
  title: string;
  files: string[];
}

/** The groups by kind, in their order, each with what its paths start with. */
const KINDS: { key: string; title: string; holds: (path: string) => boolean }[] = [
  { key: "policies", title: "Policies", holds: (path) => path.startsWith("policies/") },
  { key: "people", title: "People", holds: (path) => path.startsWith("resources/people") },
  { key: "resources", title: "Resources", holds: (path) => path.startsWith("resources/") },
  { key: "workflows", title: "Workflows", holds: (path) => /^(workflows|scenarios)\//.test(path) },
  { key: "sites", title: "Sites", holds: (path) => path.startsWith("sites/") },
];

/** A file's group: its app's (`app:<name>` for `apps/<name>/…`), else its kind's, else `other`. */
function groupOf(path: string): string {
  const app = /^apps\/([^/]+)\//.exec(path)?.[1];
  return app !== undefined ? `app:${app}` : (KINDS.find((kind) => kind.holds(path))?.key ?? "other");
}

/**
 * A change's files grouped by what they are: policies, people (`resources/people*`), resources,
 * workflows (with their scenarios), sites, then each app's (`apps/<name>/`, by name), then the
 * rest; a group with no file left out, each group's files in the order given.
 */
export function groupFiles(files: readonly string[]): FileGroup[] {
  const groups = Map.groupBy(files, groupOf);
  const apps = [...groups.keys()].filter((key) => key.startsWith("app:")).toSorted();
  return [
    ...KINDS,
    ...apps.map((key) => ({ key, title: `App ${key.slice(4)}` })),
    { key: "other", title: "Other files" },
  ].flatMap(({ key, title }) => {
    const grouped = groups.get(key);
    return grouped ? [{ key, title, files: grouped }] : [];
  });
}

/** What Publish's approval carries in its `details`: the change, and the facts the policy decided on. */
export interface ChangeRef {
  change: { id: string; title: string; branch: string };
  facts: ChangeFacts;
}

/** An approval's details as a change's Publish, when they are one (`{ change, facts }`, or its JSON), told by its shape. */
export function asChangeRef(details: unknown): ChangeRef | undefined {
  let value = details;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { change, facts } = value as Partial<Record<keyof ChangeRef, Record<string, unknown>>>;
  const named = change && ["id", "title", "branch"].every((key) => typeof change[key] === "string");
  return named && Array.isArray(facts?.touches) ? (value as ChangeRef) : undefined;
}

/** The draft a change's run is of (`change:<id>`, or `change:<id>~<n>` for a later run), if it is one. */
export const changeIdOf = (runId: string) => /^change:([\w-]{1,64})(?:~\d+)?$/.exec(runId)?.[1];
