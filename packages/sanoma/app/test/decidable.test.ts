import type { ApprovalState, RunSummary } from "@sanoma-ai/workflows";
import { sanoma } from "@sanoma-ai/workflows/resources";
import type { PeopleResource } from "@sanoma-ai/workflows/shared";
import { describe, expect, it } from "vitest";
import { decidableBy } from "../src/lib/decidable.ts";

// The Inbox's For you: which pending approvals a person may decide, by the config description's people.

const entry = (startedBy: string) => ({
  run: {
    runId: `run-${startedBy}`,
    workflow: "payout",
    status: "waiting",
    createdAt: 0,
    startedBy: { id: startedBy },
    approvals: [],
  } satisfies RunSummary,
  approval: {
    id: "approval-1",
    title: "Payouts need finance",
    approver: { group: "finance" },
    requestedBy: "policy",
    covers: [],
    status: "pending",
    requestedAt: 0,
    refused: [],
  } satisfies ApprovalState,
});

/** The description's resources: ada, bo and cy, and a finance group of these of them. */
const finance = (...members: ("ada" | "bo")[]): PeopleResource[] => {
  const people = {
    ada: sanoma.person({ id: "ada" }),
    bo: sanoma.person({ id: "bo" }),
    cy: sanoma.person({ id: "cy" }),
  };
  return [...Object.values(people), sanoma.group({ name: "finance", members: members.map((id) => people[id]) })];
};

describe("decidableBy", () => {
  const entries = [entry("ada"), entry("cy")];
  const ids = (list: ReturnType<typeof entry>[]) => list.map((e) => e.run.startedBy?.id);

  it("lists the starter's own approval while they alone are in the approver group", () => {
    expect(ids(decidableBy("ada", ["finance"], finance("ada"))(entries))).toEqual(["ada", "cy"]);
  });

  it("leaves it out once someone else in the group could decide it", () => {
    expect(ids(decidableBy("ada", ["finance"], finance("ada", "bo"))(entries))).toEqual(["cy"]);
    expect(ids(decidableBy("bo", ["finance"], finance("ada", "bo"))(entries))).toEqual(["ada", "cy"]);
  });

  it("leaves out an approval no longer pending: decided, rejected or withdrawn", () => {
    const settled = (["approved", "rejected", "withdrawn"] as const).map((status) => {
      const e = entry("cy");
      return { ...e, approval: { ...e.approval, status } };
    });
    expect(
      decidableBy("ada", ["finance"], finance("ada"))([...settled, entry("ada")]).map((e) => e.approval.status),
    ).toEqual(["pending"]);
  });

  it("lists nothing for someone outside the group, or while the page knows no name", () => {
    expect(decidableBy("cy", [], finance("ada"))(entries)).toEqual([]);
    expect(decidableBy(undefined, ["finance"], finance("ada"))(entries)).toEqual([]);
  });
});
