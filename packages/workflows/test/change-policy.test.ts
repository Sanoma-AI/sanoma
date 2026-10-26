import { describe, expect, it } from "vitest";
import { decide } from "../src/call.ts";
import { type ChangeFacts, changeOps, runtimeHold, touchesOf } from "../src/change.ts";
import { sanoma } from "../src/constructors.ts";
import type { ApprovalState } from "../src/define.ts";
import { allowAll, resolveConfig } from "../src/index.ts";
import type { Run } from "../src/run.ts";
import { CHANGE_MERGE, CHANGE_OPEN } from "../src/shared.ts";
import { rootWith } from "./harness.ts";

// The runtime's own rule on a change: a merge of a change to the rules waits for admin, before
// any company policy is asked, under `allowAll` too.

const [ada, bo, cy] = ["ada", "bo", "cy"].map((id) => sanoma.person({ id }));
const admin = sanoma.group({ name: "admin", members: [cy!] });
const finance = sanoma.group({ name: "finance", members: [ada!] });
const people = [ada!, bo!, cy!, admin, finance];

const facts = (over: Partial<ChangeFacts> = {}): ChangeFacts => ({
  touches: touchesOf(["policies/money.cedar"]),
  strandedRuns: 0,
  stranded: [],
  checksOk: true,
  rules: true,
  ...over,
});
const mergeInput = (f: ChangeFacts) => ({ id: "c1", number: 7, head: "abc", title: "Money", facts: f });
const approvedBy = (approver: ApprovalState["approver"], covers = [CHANGE_MERGE]): ApprovalState => ({
  id: "approval-1",
  title: "A change to the rules waits for admin",
  approver,
  requestedBy: "policy",
  covers,
  status: "approved",
  requestedAt: 0,
  decidedBy: "cy",
  refused: [],
});
const HOLD = {
  kind: "approve",
  approver: { group: "admin" },
  title: "A change to the rules waits for admin",
  reasons: ["sanoma:rules-wait-for-admin"],
};

describe("touchesOf", () => {
  it("is each path and each of its parent directories, sorted, each once", () => {
    expect(
      touchesOf(["resources/finance/cards.ts", "policies/money.cedar", "resources/people.ts", "README.md"]),
    ).toEqual([
      "README.md",
      "policies/",
      "policies/money.cedar",
      "resources/",
      "resources/finance/",
      "resources/finance/cards.ts",
      "resources/people.ts",
    ]);
    expect(touchesOf([])).toEqual([]);
  });
});

describe("runtimeHold", () => {
  it("holds a merge of a change to the rules for admin, and nothing else", () => {
    expect(runtimeHold(CHANGE_MERGE, mergeInput(facts()), [], people)).toEqual(HOLD);
    expect(runtimeHold(CHANGE_MERGE, mergeInput(facts({ rules: false })), [], people)).toEqual(HOLD);
    const elsewhere = touchesOf(["resources/finance/cards.ts"]);
    expect(
      runtimeHold(CHANGE_MERGE, mergeInput(facts({ rules: false, touches: elsewhere })), [], people),
    ).toBeUndefined();
    expect(runtimeHold(CHANGE_OPEN, { id: "c1", title: "Money" }, [], people)).toBeUndefined();
  });

  it("is lifted by an approval addressed to admin covering the merge, and by no other", () => {
    expect(runtimeHold(CHANGE_MERGE, mergeInput(facts()), [approvedBy({ group: "admin" })], people)).toBeUndefined();
    expect(runtimeHold(CHANGE_MERGE, mergeInput(facts()), [approvedBy({ group: "finance" })], people)).toEqual(HOLD);
    expect(
      runtimeHold(CHANGE_MERGE, mergeInput(facts()), [approvedBy({ group: "admin" }, [CHANGE_OPEN])], people),
    ).toEqual(HOLD);
  });

  it("denies the merge while no data file declares admin", () => {
    expect(runtimeHold(CHANGE_MERGE, mergeInput(facts()), [], [ada!, finance])).toEqual({
      kind: "deny",
      reason:
        'A change to the policies or the people waits for the group "admin", which no data file declares: ' +
        "declare it in resources/people.ts",
      reasons: ["sanoma:rules-wait-for-admin"],
    });
  });
});

/** A run of `change` as `bo` on the root's resolved config, with `approvals` so far: what `decide` reads. */
const runAt = (root: string, approvals: ApprovalState[] = []) => {
  const resolved = resolveConfig({ workflows: [], connectors: [], root });
  const run = { id: "r1", workflow: "change", approvals, actor: { id: "bo" }, seq: 0, state: { ...resolved, root } };
  return { resolved, run: run as unknown as Run };
};

describe("a run's decision on a merge", () => {
  const peopleFile = `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
export const bo = sanoma.person({ id: "bo" });
export const cy = sanoma.person({ id: "cy" });
export const admin = sanoma.group({ name: "admin", members: [cy] });
export const finance = sanoma.group({ name: "finance", members: [ada] });
`;
  const ownership = `@hold("finance")
@title("Finance reviews changes to its resources")
forbid (principal, action == Sanoma::Action::"sanoma.change.merge", resource is Sanoma::Change)
when { resource.touches.contains("resources/finance/") }
unless { principal in Sanoma::Group::"finance" };
`;
  const merge = changeOps.change.merge;

  it("holds a change to the rules for admin under allowAll, and allows any other", async () => {
    const { resolved, run } = runAt(rootWith({ "resources/people.ts": peopleFile }));
    expect(resolved.policy).toBe(allowAll);
    expect(await decide(run, merge, mergeInput(facts()))).toEqual(HOLD);
    const other = facts({ rules: false, touches: touchesOf(["resources/finance/cards.ts"]) });
    expect(await decide(run, merge, mergeInput(other))).toEqual({ kind: "allow" });
    const lifted = runAt(run.state.root!, [approvedBy({ group: "admin" })]).run;
    expect(await decide(lifted, merge, mergeInput(facts()))).toEqual({ kind: "allow" });
  });

  it("asks the company's policy only once the runtime's rule is lifted", async () => {
    const root = rootWith({ "resources/people.ts": peopleFile, "policies/ownership.cedar": ownership });
    const both = mergeInput(facts({ touches: touchesOf(["policies/money.cedar", "resources/finance/cards.ts"]) }));
    const { resolved, run } = runAt(root);
    expect(resolved.policyProblems).toEqual([]);
    expect(await decide(run, merge, both)).toEqual(HOLD);
    const byAdmin = runAt(root, [approvedBy({ group: "admin" })]).run;
    expect(await decide(byAdmin, merge, both)).toMatchObject({
      kind: "approve",
      approver: { group: "finance" },
      reasons: ["policies/ownership.cedar#1"],
    });
    const byBoth = runAt(root, [approvedBy({ group: "admin" }), approvedBy({ group: "finance" })]).run;
    expect(await decide(byBoth, merge, both)).toMatchObject({ kind: "allow" });
  });

  it("denies a change to the rules while the running instance declares no admin", async () => {
    const root = rootWith({ "resources/people.ts": peopleFile.replace(/^export const admin.*\n/m, "") });
    expect(await decide(runAt(root).run, merge, mergeInput(facts()))).toMatchObject({
      kind: "deny",
      reasons: ["sanoma:rules-wait-for-admin"],
    });
  });
});
