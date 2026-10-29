import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFake } from "@sanoma-ai/testing";
import {
  cedarPolicy,
  defineConnector,
  defineWorkflow,
  loadPolicies,
  type PreviewAnswer,
  resolveConfig,
  type SanomaConfig,
} from "@sanoma-ai/workflows";
import {
  describeConfig,
  type PermissionsGrid,
  type PermissionsRow,
  permissionsGrid,
  readPeople,
} from "@sanoma-ai/workflows/describe";
import { defineFake } from "@sanoma-ai/workflows/fake";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type CellChange,
  cellSpoken,
  cellWords,
  compareAnswers,
  diffGrids,
  diffSummary,
  type GridDiff,
  onlyChanged,
} from "../src/lib/grid-diff.ts";

// The Permissions grid diffed (`src/lib/grid-diff.ts`): two grids of `permissionsGrid` over two
// policies, as `permissions.test.ts` builds one, and hand-made grids for what a policy alone
// does not show; then `PermissionsDiff` as the server renders it. No database.

const shop = defineConnector("shop", {
  refunds: {
    create: { effect: "money", input: z.object({ amount: z.number().int() }), output: z.object({ id: z.string() }) },
    list: { effect: "read", input: z.object({}), output: z.array(z.object({ id: z.string() })) },
  },
});
const fake = defineFake(shop, {
  initial: () => ({}),
  ops: () => ({ refunds: { create: async () => ({ id: "re_1" }), list: async () => [] } }),
});
const refund = defineWorkflow({
  name: "refund",
  title: "Refund",
  trigger: "manual",
  input: z.object({ amount: z.number().int() }),
  uses: [shop.refunds.create],
  run: async (ctx, { amount }) => ctx.shop.refunds.create({ amount }),
});

const root = mkdtempSync(join(tmpdir(), "sanoma-grid-diff-"));
mkdirSync(join(root, "resources"));
writeFileSync(
  join(root, "resources", "people.ts"),
  `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
export const finance = sanoma.group({ name: "finance", members: [ada] });
`,
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const config: SanomaConfig = { workflows: [refund], connectors: [withFake(shop, fake)], root };
const resolved = resolveConfig(config);
const description = describeConfig(config);
const people = readPeople(root).people;

/** The grid under the Cedar policies `text`, in one file. */
const gridUnder = (text: string): PermissionsGrid =>
  permissionsGrid(
    { policy: cedarPolicy(resolved, loadPolicies([{ file: "policies/p.cedar", text }]).policies, people) },
    description,
  );

// Main's: a hold on the start for those outside finance, a deny on agents' direct read, a hold
// on agents' refunds.
const MAIN = `@hold("finance")
forbid (principal, action == Sanoma::Action::"workflow:refund", resource)
unless { principal in Sanoma::Group::"finance" };

@id("no-agent-reads")
forbid (principal in Sanoma::Group::"agents", action == Sanoma::Action::"shop.refunds.list", resource);

@id("agent-refunds")
@hold("finance")
forbid (principal in Sanoma::Group::"agents", action == Sanoma::Action::"shop.refunds.create", resource);
`;

// The branch's: the start allowed (looser), agents' read held (looser), agents' refunds in the
// run refused (tighter), and finance's own direct read refused (tighter). Only the read is direct.
const BRANCH = `@id("agent-reads")
@hold("finance")
forbid (principal in Sanoma::Group::"agents", action == Sanoma::Action::"shop.refunds.list", resource);

@id("agent-refunds")
forbid (principal in Sanoma::Group::"agents", action == Sanoma::Action::"shop.refunds.create", resource);

@id("finance-reads-nothing")
forbid (principal in Sanoma::Group::"finance", action == Sanoma::Action::"shop.refunds.list", resource);
`;

const allow: PreviewAnswer = { answer: "allow" };
const deny: PreviewAnswer = { answer: "deny" };
const depends: PreviewAnswer = { answer: "depends" };
const hold = (group: string): PreviewAnswer => ({ answer: "hold", approver: { group } });
const row = (id: string, cells: PreviewAnswer[]): PermissionsRow => ({ id, cells });

/** Each row's changes, by id (an operation under a workflow as `workflow/op`). */
const changesOf = (diff: GridDiff) =>
  Object.fromEntries([
    ...diff.workflows.flatMap((w) => [
      [w.id, w.cells.map((c) => c.change)],
      ...(w.ops ?? []).map((op) => [`${w.id}/${op.id}`, op.cells.map((c) => c.change)]),
    ]),
    ...diff.ops.map((op) => [op.id, op.cells.map((c) => c.change)]),
  ]);

describe("compareAnswers", () => {
  it("orders deny, hold and allow, and calls depends, another approver, a new and a gone answer what they are", () => {
    const cases: [PreviewAnswer | undefined, PreviewAnswer | undefined, CellChange][] = [
      [deny, hold("finance"), "looser"],
      [deny, allow, "looser"],
      [hold("finance"), allow, "looser"],
      [allow, hold("finance"), "tighter"],
      [allow, deny, "tighter"],
      [hold("finance"), deny, "tighter"],
      [hold("finance"), hold("admin"), "changed"],
      [hold("finance"), { answer: "hold", approver: "ada" }, "changed"],
      [depends, allow, "changed"],
      [deny, depends, "changed"],
      [undefined, allow, "added"],
      [deny, undefined, "removed"],
      [allow, allow, "same"],
      [depends, depends, "same"],
      [hold("finance"), hold("finance"), "same"],
    ];
    expect(cases.map(([before, after]) => compareAnswers(before, after))).toEqual(cases.map(([, , want]) => want));
  });

  it("calls a cell whose rule alone changed the same", () => {
    const file = "policies/p.cedar";
    expect(compareAnswers({ ...deny, rule: { id: "a", file } }, { ...deny, rule: { id: "b", file } })).toBe("same");
  });
});

describe("diffGrids", () => {
  it("diffs two policies' grids: every loosening and tightening, each cell before and after", () => {
    const before = gridUnder(MAIN);
    const after = gridUnder(BRANCH);
    const diff = diffGrids(before, after);
    expect(diff.groups).toEqual([
      { group: null, status: "same" },
      { group: "agents", status: "same" },
      { group: "finance", status: "same" },
    ]);
    // Columns: no group, agents, finance.
    expect(changesOf(diff)).toEqual({
      refund: ["looser", "looser", "same"],
      "refund/shop.refunds.create": ["same", "tighter", "same"],
      "shop.refunds.list": ["same", "looser", "tighter"],
      // The runtime's listing of apps, built in: no policy names it.
      "sanoma.apps.list": ["same", "same", "same"],
      "sanoma.connection.bind": ["same", "same", "same"],
      "sanoma.connection.create": ["same", "same", "same"],
      "sanoma.connection.disconnect": ["same", "same", "same"],
    });
    expect(diff.workflows[0]).toMatchObject({ id: "refund", title: "Refund", status: "changed" });
    expect(diff.changed).toBe(true);
    expect(diff.counts).toEqual({ same: 16, looser: 3, tighter: 2, changed: 0, added: 0, removed: 0 });
    const list = diff.ops.find((op) => op.id === "shop.refunds.list")!;
    expect(list.cells.map(cellWords)).toEqual(["allow", "deny → hold · group finance", "allow → deny"]);
    expect(cellWords(diff.workflows[0]!.cells[0]!)).toBe("hold · group finance → allow");
    expect(diffSummary(diff)).toEqual(["3 loosened", "2 tightened"]);
  });

  it("finds nothing between a grid and itself, even when only a rule's id changed", () => {
    const diff = diffGrids(gridUnder(MAIN), gridUnder(MAIN.replace("no-agent-reads", "agents-read-nothing")));
    expect(diff.changed).toBe(false);
    expect(diff.counts.same).toBe(21);
    expect(onlyChanged(diff)).toMatchObject({ workflows: [], ops: [] });
    expect(diffSummary(diff)).toEqual([]);
  });

  it("calls a change of approver or to depends changed", () => {
    const before = { groups: [null], workflows: [], ops: [row("a", [hold("finance")]), row("b", [deny])] };
    const after = { groups: [null], workflows: [], ops: [row("a", [hold("admin")]), row("b", [depends])] };
    const diff = diffGrids(before, after);
    expect(changesOf(diff)).toEqual({ a: ["changed"], b: ["changed"] });
    expect(diff.ops.map((op) => cellWords(op.cells[0]!))).toEqual([
      "hold · group finance → hold · group admin",
      "deny → depends",
    ]);
    expect(diff.ops.map((op) => cellSpoken(op.cells[0]!))).toEqual([
      "changed: hold for group finance, then hold for group admin",
      "changed: deny, then depends",
    ]);
    expect(diffSummary(diff)).toEqual(["2 changed"]);
  });

  it("puts a new group in after's order and a removed one last, its cells added or removed", () => {
    const before = { groups: [null, "ops", "support"], workflows: [], ops: [row("a", [allow, deny, hold("ops")])] };
    const after = { groups: [null, "finance", "ops"], workflows: [], ops: [row("a", [allow, deny, allow])] };
    const diff = diffGrids(before, after);
    expect(diff.groups).toEqual([
      { group: null, status: "same" },
      { group: "finance", status: "added" },
      { group: "ops", status: "same" },
      { group: "support", status: "removed" },
    ]);
    expect(diff.ops[0]!.cells).toEqual([
      { before: allow, after: allow, change: "same" },
      { after: deny, change: "added" },
      { before: deny, after: allow, change: "looser" },
      { before: hold("ops"), change: "removed" },
    ]);
    expect(diff.ops[0]!.cells.map(cellWords)).toEqual(["allow", "deny", "deny → allow", "hold · group ops"]);
    expect(diffSummary(diff)).toEqual(["1 loosened", "new column finance", "removed column support"]);
  });

  it("adds a new workflow with its operations, removes a direct operation, and keeps an operation's occurrences apart", () => {
    const flow = (ops: PermissionsRow[]) => ({ ...row("refund", [allow]), title: "Refund", ops });
    const before: PermissionsGrid = {
      groups: [null],
      workflows: [flow([row("shop.a", [allow]), row("shop.a", [hold("ops")])])],
      ops: [row("shop.a", [allow]), row("shop.gone", [deny])],
    };
    const after: PermissionsGrid = {
      groups: [null],
      workflows: [
        flow([row("shop.a", [allow]), row("shop.a", [allow]), row("shop.a", [deny])]),
        { ...row("payout", [hold("ops")]), ops: [row("shop.pay", [allow])] },
      ],
      ops: [row("shop.a", [allow])],
    };
    const diff = diffGrids(before, after);
    // The second occurrence loosened, a third added: by `id#occurrence`, not by id.
    expect(diff.workflows[0]!.ops!.map((op) => [op.status, op.cells[0]!.change])).toEqual([
      ["same", "same"],
      ["changed", "looser"],
      ["added", "added"],
    ]);
    expect(diff.workflows[0]!.status).toBe("changed");
    expect(diff.workflows[1]).toMatchObject({
      id: "payout",
      status: "added",
      ops: [{ id: "shop.pay", status: "added" }],
    });
    expect(diff.ops.map((op) => [op.id, op.status])).toEqual([
      ["shop.a", "same"],
      ["shop.gone", "removed"],
    ]);
    expect(diff.ops[1]!.cells).toEqual([{ before: deny, change: "removed" }]);
    // The new workflow is one new row with its operation, the second occurrence another.
    expect(diffSummary(diff)).toEqual(["1 loosened", "2 new rows", "1 removed row"]);

    // Only what changed: the refund for its operations, only those that did; at most two lines.
    const changed = onlyChanged(diff);
    expect(changed.workflows.map((w) => [w.id, w.ops!.length])).toEqual([
      ["refund", 2],
      ["payout", 1],
    ]);
    expect(changed.ops.map((op) => op.id)).toEqual(["shop.gone"]);
    expect(onlyChanged(diff, 2)).toMatchObject({
      workflows: [{ id: "refund", ops: [{ status: "changed" }] }],
      ops: [],
    });
    // No room for an operation under the refund, whose own cells are the same: it goes too, and
    // the new payout, its own cells new, takes the one line.
    expect(onlyChanged(diff, 1)).toMatchObject({ workflows: [{ id: "payout", ops: [] }], ops: [] });
  });

  it("leaves blank a cell neither grid has: a removed row's, in a new column", () => {
    const diff = diffGrids(
      { groups: [null], workflows: [], ops: [row("gone", [deny])] },
      { groups: [null, "finance"], workflows: [], ops: [] },
    );
    expect(diff.ops[0]!.cells).toEqual([{ before: deny, change: "removed" }, { change: "same" }]);
    expect(cellWords(diff.ops[0]!.cells[1]!)).toBe("");
  });
});

describe("PermissionsDiff", () => {
  // By a path TypeScript does not follow: the components are JSX and DOM, checked by typecheck:ui.
  type Diff = (props: { before: PermissionsGrid; after: PermissionsGrid }) => ReactNode;
  const load = (path: string) => import(new URL(path, import.meta.url).href) as Promise<{ PermissionsDiff: Diff }>;

  /** The diff of `before` and `after` as the server renders it, in a router, as the app's pages are. */
  const render = async (before: PermissionsGrid, after: PermissionsGrid) => {
    const { PermissionsDiff } = await load("../src/components/permissions-diff.tsx");
    const router = createRouter({
      routeTree: createRootRoute({ component: () => createElement(PermissionsDiff, { before, after }) }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    return renderToString(createElement(RouterProvider, { router })).replaceAll("<!-- -->", "");
  };

  it("shows the count line and only the changed rows, each changed cell before → after with its words spoken", async () => {
    const html = await render(gridUnder(MAIN), gridUnder(BRANCH));
    expect(html).toContain("3 loosened · 2 tightened");
    expect(html).toContain("Show unchanged rows");
    expect(html).toContain('aria-label="loosened: hold for group finance, then allow"');
    expect(html).toContain(">hold · group finance → allow<");
    expect(html).toContain('aria-label="tightened: allow, then deny"');
    expect(html).toContain(">allow → deny<");
    // The changed workflow links to its page; its unchanged cells are muted marks.
    expect(html).toMatch(/<a [^>]*href="\/workflows\/refund"[^>]*>Refund<\/a>/);
    expect(html).toMatch(/<span class="text-muted-foreground">allow<\/span>/);
    // The new column's name in the count line, the added workflow no link.
    const added = await render(
      { groups: [null], workflows: [], ops: [] },
      { groups: [null, "finance"], workflows: [{ ...row("payout", [allow, deny]), ops: [] }], ops: [] },
    );
    expect(added).toContain("new column finance · 1 new row");
    expect(added).not.toContain('href="/workflows/payout"');
    expect(added).toContain('aria-label="new: deny"');
  });

  it("says nothing changes for two equal grids", async () => {
    const html = await render(gridUnder(MAIN), gridUnder(MAIN));
    expect(html).toContain("No one&#x27;s answers change");
    expect(html).not.toContain("<table");
  });
});
