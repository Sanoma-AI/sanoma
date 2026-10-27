import type { CheckResult } from "@sanoma-ai/workflows";
import { changeIdOf } from "@sanoma-ai/workflows/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type App, startApp } from "../src/index.ts";
import type { DraftCard } from "../src/lib/chat.ts";
import { tellCommits } from "../src/server/agent/checkout.ts";
import { openChange } from "../src/server/core.ts";
import { asChangeRef, groupFiles, phaseLabel } from "../src/lib/changes.ts";
import { cellWords, diffGrids } from "../src/lib/grid-diff.ts";
import { barLabels } from "./bar-helpers.ts";
import { publishedAgain, publishOf, REFUNDS_WAIT, renderDraftCard, useChangeApp } from "./fixtures/change.ts";

// The Changes section and a change's review: the words and groups (`lib/changes.ts`), then a real
// change of a draft that edits `policies/`, over C5's fake host, as the server renders its pages;
// a chat's draft sent for review and told its new commits; and the draft card as the server
// renders it. Needs Postgres (`pnpm db:up`) and the built app.

describe("a change's words", () => {
  it("names each phase, Publish waiting by its approver", () => {
    expect(phaseLabel({ phase: "waiting", decision: { answer: "hold", approver: { group: "admin" } } })).toBe(
      "Waiting for admin",
    );
    expect(phaseLabel({ phase: "waiting", decision: { answer: "allow", approver: "alice" } })).toBe(
      "Waiting for alice",
    );
    expect(phaseLabel({ phase: "merged" })).toBe("Published");
    expect(
      ["opening", "checking", "planning", "merging", "deploying", "closed", "blocked"].map((phase) =>
        phaseLabel({ phase: phase as "opening" }),
      ),
    ).toEqual(["Opening", "Checking", "Planning", "Merging", "Deploying", "Closed", "Blocked"]);
  });

  it("groups the files by kind, then each app's, then the rest", () => {
    expect(
      groupFiles([
        "README.md",
        "apps/crm/policies/x.cedar",
        "sites/www/index.tsx",
        "workflows/refund.ts",
        "resources/people.ts",
        "apps/books/workflows/a.ts",
        "scenarios/refund.feature",
        "resources/finance/cards.ts",
        "policies/money.cedar",
      ]),
    ).toEqual([
      { key: "policies", title: "Policies", files: ["policies/money.cedar"] },
      { key: "people", title: "People", files: ["resources/people.ts"] },
      { key: "resources", title: "Resources", files: ["resources/finance/cards.ts"] },
      { key: "workflows", title: "Workflows", files: ["workflows/refund.ts", "scenarios/refund.feature"] },
      { key: "sites", title: "Sites", files: ["sites/www/index.tsx"] },
      { key: "app:books", title: "App books", files: ["apps/books/workflows/a.ts"] },
      { key: "app:crm", title: "App crm", files: ["apps/crm/policies/x.cedar"] },
      { key: "other", title: "Other files", files: ["README.md"] },
    ]);
  });

  it("reads Publish's details as a change, and nothing else", () => {
    const ref = {
      change: { id: "rules", title: "Rules", branch: "draft/rules" },
      facts: { touches: ["policies/"], strandedRuns: 0, stranded: [], checksOk: true, rules: true },
    };
    expect(asChangeRef(JSON.stringify(ref))).toEqual(ref);
    expect(asChangeRef(ref)).toEqual(ref);
    expect(asChangeRef("Refund 40")).toBeUndefined();
    expect(asChangeRef(JSON.stringify({ problems: [], rebinds: [], steps: [] }))).toBeUndefined();
    expect(asChangeRef(JSON.stringify({ change: { id: "x" }, facts: { touches: [] } }))).toBeUndefined();
  });

  it("finds a change run's draft", () => {
    expect(changeIdOf("change:rules")).toBe("rules");
    expect(changeIdOf("change:rules~2")).toBe("rules");
    expect(changeIdOf("change:rules:deploy")).toBeUndefined();
    expect(changeIdOf("0b5d4c1e")).toBeUndefined();
  });
});

describe("the Changes section", () => {
  const fixture = useChangeApp("changes");
  let runId: string;
  /** The app over the same config with no repository, so no remote. */
  let bare: App;

  beforeAll(async () => {
    runId = await fixture.draft(
      "rules",
      { "policies/refunds.cedar": REFUNDS_WAIT },
      { title: "Refunds wait for finance" },
    );
    bare = await startApp(fixture.testApp.config, { port: 0 });
  }, 60_000);
  afterAll(async () => {
    await bare?.close();
  });

  it("puts Changes after Inbox in the bar when the repository has a remote, and not without one", async () => {
    const { html } = await fixture.page("/inbox");
    expect(barLabels(html)[0]).toEqual(["Inbox", "Changes", "Workflows"]);
    const without = await (await fetch(new URL("/inbox", bare.url))).text();
    expect(barLabels(without)[0]).toEqual(["Inbox", "Workflows"]);
  });

  it("lists the open change, and says how one opens when none is done", async () => {
    const open = await fixture.page("/changes");
    expect(open.status).toBe(200);
    expect(open.html).toMatch(/<h1[^>]*>Changes<span[^>]*>1<\/span><\/h1>/);
    expect(open.html).toContain('href="/changes/rules"');
    expect(open.html).toContain(">Refunds wait for finance</a>");
    expect(open.html).toContain("Waiting for admin");
    const pr = fixture.remote.pullOf("draft/rules")!;
    expect(open.html).toContain(`href="${pr.url}"`);
    expect(open.html).toContain(`#${pr.number} <span aria-hidden="true">↗</span>`);

    const done = await fixture.page("/changes?show=done");
    expect(done.html).toContain("No change is done yet");
    expect(done.html).toContain("A change opens when you send a draft for review.");
  });

  it("reviews the change: its phase, its files by kind, the grid diffed, the answer and Publish", async () => {
    const { status, html } = await fixture.page("/changes/rules");
    expect(status).toBe(200);
    expect(html).toMatch(/<h1[^>]*>Refunds wait for finance<\/h1>/);
    expect(html).toContain("Waiting for admin");
    expect(html).toContain("<code>draft/rules</code>");
    expect(html).toContain('href="/workflows/change/runs/change%3Arules"');
    // What changed, by kind.
    expect(html).toContain(">What changed</h2>");
    expect(html).toContain(">Policies</h3>");
    expect(html).toContain("policies/refunds.cedar</code>");
    // Who may do what: main's grid against the branch's, a changed cell's words.
    expect(html).toContain(">Who may do what</h2>");
    const diff = diffGrids(fixture.gridWith({}), fixture.gridWith({ "policies/refunds.cedar": REFUNDS_WAIT }));
    const changed = diff.workflows.find((row) => row.id === "refund")!.cells.find((cell) => cell.change !== "same")!;
    expect(cellWords(changed)).toBe("allow → hold · group finance");
    expect(html).toContain(cellWords(changed));
    // The decision floating: the runtime's hold for admin, the checks, and Publish.
    expect(html).toContain("Publish waits for admin");
    expect(html).toContain("A change to the rules waits for admin");
    expect(html).toMatch(/<dt[^>]*>Checks<\/dt><dd[^>]*>pass<\/dd>/);
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Publish<\/button>/);
    expect(html).toContain("Rejecting closes the change.");
  });

  it("links the change from Publish in the Inbox", async () => {
    const publish = await publishOf(fixture.testApp.client, runId);
    const { html } = await fixture.page(`/inbox?approval=${encodeURIComponent(`${runId}/${publish.id}`)}`);
    expect(html).toMatch(
      /<dt[^>]*>Change<\/dt><dd[^>]*><a [^>]*href="\/changes\/rules"[^>]*>Refunds wait for finance<\/a>/,
    );
    expect(html).toContain('aria-label="What the change edits"');
    // Decided as Publish here too.
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Publish<\/button>/);
    // The glance in place of the details' JSON.
    expect(html).not.toContain("&quot;touches&quot;");
  });

  it("leads from the change's run to its review", async () => {
    const { html } = await fixture.page(`/workflows/change/runs/${encodeURIComponent(runId)}`);
    expect(html).toMatch(/<a [^>]*href="\/changes\/rules"[^>]*>Review<\/a>/);
  });

  it("shows Published once admin publishes it, and lists it as done", async () => {
    await fixture.testApp.client.decide(runId, { decision: "approve", by: { id: "ada" } });
    await fixture.testApp.client.result(runId);
    const { html } = await fixture.page("/changes/rules");
    expect(html).toContain("Published");
    expect(html).toMatch(/<dt[^>]*>Merged<\/dt>/);
    expect(html).not.toContain("Rejecting closes the change.");
    const done = await fixture.page("/changes?show=done");
    // One row per draft: its latest run's.
    expect(done.html.match(/href="\/changes\/rules"/g)).toHaveLength(1);
  });

  it("lists a draft once, by its latest run: open again, it leaves Done", async () => {
    const again = await fixture.draft("rules", { "policies/more.cedar": "\n" }, { title: "More rules" });
    expect(again).toBe("change:rules~2");
    const open = await fixture.page("/changes");
    expect(open.html.match(/href="\/changes\/rules"/g)).toHaveLength(1);
    expect(open.html).toContain(">More rules</a>");
    expect((await fixture.page("/changes?show=done")).html).not.toContain('href="/changes/rules"');
    await fixture.testApp.client.changeEvent("rules", { kind: "close", by: "alice" }, { by: "alice" });
    await fixture.testApp.client.result(again);
  });

  it("is not found for a draft with no change", async () => {
    const { status, html } = await fixture.page("/changes/nothing");
    expect(status).toBe(404);
    expect(html).toContain("No change nothing.");
  });

  it("sends a chat's draft for review as its person, titled as the chat, and tells it the draft's new commits", async () => {
    const { client } = fixture.testApp;
    await client.chats.open({ id: "card", person: "alice", engine: "loop", title: "Refunds name the order" });
    fixture.repo.edit("card", { "workflows/notes.md": "Refunds name the order.\n" });
    // A draft with no change is told nothing.
    await tellCommits(client, "card", { id: "alice" });
    await expect(openChange({ client }, { id: "ada" }, "card", fixture.app.url)).rejects.toMatchObject({ status: 404 });

    const { runId: opened } = await openChange({ client }, { id: "alice" }, "card", fixture.app.url);
    expect(opened).toBe("change:card");
    const page = new URL("/changes/card", fixture.app.url).href;
    const publish = await publishOf(client, opened);
    const view = (await client.change("card"))!;
    expect(view.startedBy).toEqual({ id: "alice" });
    expect(view.state.title).toBe("Refunds name the order");
    expect(fixture.remote.pullOf("draft/card")!.title).toBe("Refunds name the order");
    expect(fixture.remote.statuses.at(-1)!.targetUrl).toBe(page);
    // Sent again while it is open, the same change.
    expect((await openChange({ client }, { id: "alice" }, "card", fixture.app.url)).runId).toBe(opened);

    // A new commit on the draft: Publish, asked on the old head, is withdrawn and asked again.
    fixture.repo.edit("card", { "workflows/notes.md": "Refunds name the order and the person.\n" });
    await tellCommits(client, "card", { id: "alice" });
    await publishedAgain(client, opened, publish);
    await client.changeEvent("card", { kind: "close", by: "alice" }, { by: "alice" });
    await client.result(opened);
    // Its change has ended: nothing is told.
    await tellCommits(client, "card", { id: "alice" });
  });
});

const passing: CheckResult = { ok: true, problems: [], warnings: [] };
const card = (checks?: CheckResult): DraftCard => ({
  draft: "card",
  branch: "draft/card",
  files: ["workflows/refund.ts"],
  summary: " workflows/refund.ts | 2 +-",
  ...(checks && { checks }),
});

describe("the draft card", () => {
  const waiting = {
    runId: "change:card",
    status: "waiting",
    approvals: [],
    createdAt: 0,
    edits: [],
    state: { phase: "waiting", decision: { answer: "hold", approver: { group: "admin" } } },
  };
  it("offers Send for review once the checks pass, and says why not before", async () => {
    const unchecked = await renderDraftCard(card(), { change: null });
    // Disabled, yet focusable, so its tip still shows.
    expect(unchecked).toMatch(
      /<button(?=[^>]*data-disabled="")[^>]*aria-disabled="true"[^>]*>Send for review<\/button>/,
    );
    expect(unchecked).toContain("Run the checks first: ask the agent to check the draft.");
    const failing = await renderDraftCard(
      card({ ok: false, problems: ["workflows/refund.ts:1:1: no"], warnings: [] }),
      {
        change: null,
      },
    );
    expect(failing).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Send for review<\/button>/);
    expect(failing).toContain("The checks fail: fix what they find first.");
    const empty = await renderDraftCard({ ...card(passing), files: [], summary: "" }, { change: null });
    expect(empty).toContain("Nothing is committed on the draft yet.");
    const ready = await renderDraftCard(card(passing), { change: null });
    expect(ready).toMatch(/<button[^>]*aria-disabled="false"[^>]*>Send for review<\/button>/);
    expect(ready).not.toContain("Merge the branch to apply it.");
  });

  it("shows the change's phase and Open the review once it has one, Send for review again once it has ended", async () => {
    const html = await renderDraftCard(card(passing), { change: waiting });
    expect(html).toContain("Waiting for admin");
    expect(html).toMatch(/<a [^>]*href="\/changes\/card"[^>]*>Open the review<\/a>/);
    expect(html).not.toContain("Send for review");
    const closed = await renderDraftCard(card(passing), {
      change: { ...waiting, status: "finished", state: { phase: "closed" } },
    });
    expect(closed).toContain("Closed");
    expect(closed).toContain("Open the review");
    expect(closed).toContain("Send for review");
    // A published draft is in main: nothing to send again.
    const merged = await renderDraftCard(card(passing), {
      change: { ...waiting, status: "finished", state: { phase: "merged" } },
    });
    expect(merged).toContain("Published");
    expect(merged).not.toContain("Send for review");
  });

  it("keeps merging by hand without a remote", async () => {
    const html = await renderDraftCard(card(passing), { remote: false });
    expect(html).toContain("Merge the branch to apply it.");
    expect(html).not.toContain("Send for review");
  });
});
