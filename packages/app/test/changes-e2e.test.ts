import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ghost } from "@sanoma-ai/connector-ghost";
import { ensureBuilt as ensureAppBuilt, startTestWorker, waitFor } from "@sanoma-ai/testing";
import {
  defineWorkflow,
  memoryLedger,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  type Worker,
} from "@sanoma-ai/workflows";
import { CHANGE_MERGE } from "@sanoma-ai/workflows/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { localGitSource } from "../../sanoma/src/source.ts";
import { copyFixture, ensureBuilt } from "../../sanoma/test/fixture.ts";
import { gitIdentity } from "../../sanoma/test/git.ts";
import { fakeRemote } from "../../workflows/test/fakes/remote.ts";
import { freshDatabase } from "../../workflows/test/harness.ts";
import type { AppContext } from "../src/context.ts";
import { type App, startApp } from "../src/index.ts";
import { tellCommits } from "../src/server/agent/checkout.ts";
import { change, hasRemote, openChange } from "../src/server/core.ts";
import { checks } from "../src/server/drafts.ts";
import { PEOPLE, pageOf, renderDraftCard } from "./fixtures/change.ts";

// The life of a change, end to end, as a person drives it through the app: the sanoma package's
// fixture company in its own git repository (`localGitSource`), cloned from a bare repository the
// fake host serves (`fakeRemote` with an `origin`). A chat's draft loosens a hold and adds a group;
// its card offers Send for review once `sanoma check` passes on it; the change waits for admin,
// as its review, the Inbox and the Permissions page show; a new commit asks Publish again; admin
// publishes, the host squash-merges and the checkout follows main. Another change is rejected,
// and closed. Needs Postgres (`pnpm db:up`) and builds the packages the fixture loads.

const appDir = fileURLToPath(new URL("..", import.meta.url));
const databaseUrl = freshDatabase("changes_e2e");

/** The fixture's own workflow, as its `workflows/hello.ts` declares it, for the app's config. */
const hello = defineWorkflow({
  name: "hello",
  title: "Say hello",
  trigger: "manual",
  input: z.object({ title: z.string().min(1) }),
  uses: [ghost.post.create, ghost.post.publish],
  run: async (ctx, { title }) => {
    const post = await ctx.ghost.post.create({ title, html: `<p>${title}</p>`, status: "draft" });
    const published = await ctx.ghost.post.publish({ id: post.id });
    return { url: published.url };
  },
});

/** Main's policy: saying hello waits for finance, unless someone in finance says it. */
const HELLO_WAITS = `@hold("finance")
@title("Hellos need finance")
forbid (principal, action == Sanoma::Action::"workflow:hello", resource)
unless { principal in Sanoma::Group::"finance" };
`;
/** The draft's: admin says hello without finance too. */
const ADMIN_SKIPS = HELLO_WAITS.replace(
  'unless { principal in Sanoma::Group::"finance" }',
  'unless { principal in Sanoma::Group::"finance" || principal in Sanoma::Group::"admin" }',
);
/** The draft's people: a `support` group besides. */
const WITH_SUPPORT = `${PEOPLE}export const support = sanoma.group({ name: "support", members: [alice] });
`;
const TITLE = "Admin skips the finance hold; support joins";

/** The bare repository the checkout was cloned from, the fake host's. */
const origin = mkdtempSync(join(tmpdir(), "sanoma-origin-"));
const remote = fakeRemote({ url: pathToFileURL(origin).href, origin });

let dir = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const atOrigin = (...args: string[]) => execFileSync("git", args, { cwd: origin, encoding: "utf8" }).trim();
let source: ReturnType<typeof localGitSource>;
let config: SanomaConfig;
let worker: Worker | undefined;
let client: SanomaClient;
let app: App;

beforeAll(async () => {
  ensureBuilt();
  ensureAppBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
  gitIdentity(vi.stubEnv);
  dir = copyFixture();
  // No scenarios: each check runs sooner.
  rmSync(join(dir, "scenarios"), { recursive: true });
  for (const folder of ["resources", "policies"]) mkdirSync(join(dir, folder));
  writeFileSync(join(dir, "resources/people.ts"), PEOPLE);
  writeFileSync(join(dir, "policies/hello.cedar"), HELLO_WAITS);
  writeFileSync(join(dir, ".gitignore"), ".sanoma/\nnode_modules/\n");
  git("init", "--quiet", "--initial-branch=main");
  git("add", "--all");
  git("commit", "--quiet", "-m", "First");
  atOrigin("init", "--quiet", "--bare", "--initial-branch=main");
  git("remote", "add", "origin", remote.url);
  git("push", "--quiet", "origin", "main");

  config = {
    workflows: [hello],
    connectors: [ghost, remote.connector],
    root: dir,
    ledger: memoryLedger(),
    databaseUrl,
  };
  source = localGitSource(dir, { databaseUrl });
  worker = await startTestWorker(config, { databaseUrl, source });
  client = await SanomaClient.connect(config, { source });
  app = await startApp(config, { port: 0, source });
}, 600_000);

afterAll(async () => {
  await app?.close();
  await client?.close();
  await worker?.stop();
  vi.unstubAllEnvs();
  for (const at of [dir, origin]) if (at) rmSync(at, { recursive: true, force: true });
});

/** The pending Publish of the change run `runId`, once it asks. */
const publishOf = async (runId: string) =>
  (
    await waitFor(
      () => client.approvals(runId),
      (approvals) => approvals.some((a) => a.status === "pending" && a.covers.includes(CHANGE_MERGE)),
    )
  ).find((a) => a.status === "pending" && a.covers.includes(CHANGE_MERGE))!;

/** Opens the draft `id` of alice's chat titled `title`, committing `files` on it: the draft. */
async function drafted(id: string, title: string, files: Record<string, string>) {
  await client.chats.open({ id, person: "alice", engine: "loop", title });
  const draft = await source.draft!(id);
  for (const [path, text] of Object.entries(files)) writeFileSync(join(draft.root, path), text);
  await draft.commit({ paths: Object.keys(files), message: title, author: "alice" });
  return draft;
}

describe("a change, from a chat's draft to main", () => {
  let runId = "";
  let draft: Awaited<ReturnType<typeof drafted>>;

  it("offers Send for review on the draft's card once sanoma check passes on the draft", async () => {
    draft = await drafted("rules", TITLE, { "policies/hello.cedar": ADMIN_SKIPS, "resources/people.ts": WITH_SUPPORT });
    // The card as the agent's turn writes it: the draft's diff and its checks, as the app runs them.
    const card = {
      draft: "rules",
      branch: draft.branch,
      ...(await source.diff!("rules")),
      checks: await checks({ source }, "rules"),
    };
    expect(card.files).toEqual(["policies/hello.cedar", "resources/people.ts"]);
    expect(card.checks).toMatchObject({ ok: true, problems: [] });
    // The app's own answers, as its root loader and the card's query read them.
    const context = { client, resolved: resolveConfig(config), source } as unknown as AppContext;
    const html = await renderDraftCard(card, {
      remote: await hasRemote(context),
      change: await change(context, "rules"),
    });
    expect(html).toMatch(/<button[^>]*aria-disabled="false"[^>]*>Send for review<\/button>/);
  });

  it("sends it for review: a pull request on the host, the change checked and waiting for admin", async () => {
    ({ runId } = await openChange({ client }, { id: "alice" }, "rules", app.url));
    expect(runId).toBe("change:rules");
    await publishOf(runId);
    const pr = remote.pullOf("draft/rules")!;
    expect(pr).toMatchObject({ state: "open", base: "main", title: TITLE, head: git("rev-parse", "draft/rules") });
    expect(atOrigin("rev-parse", "draft/rules")).toBe(pr.head);
    expect(remote.statuses.at(-1)).toMatchObject({
      sha: pr.head,
      state: "pending",
      description: "A change to the rules waits for admin",
      targetUrl: new URL("/changes/rules", app.url).href,
    });
  });

  it("shows the review: the grid diffed with the new column, Waiting for admin, and Publish", async () => {
    const { status, html } = await pageOf(app, "/changes/rules");
    expect(status).toBe(200);
    expect(html).toMatch(new RegExp(`<h1[^>]*>${TITLE}</h1>`));
    expect(html).toContain("Waiting for admin");
    expect(html).toContain("policies/hello.cedar</code>");
    expect(html).toContain("resources/people.ts</code>");
    // Main's grid against the branch's, as sanoma check reported it.
    expect(html).toContain("1 loosened · new column support");
    expect(html).toMatch(/<th[^>]*scope="col"[^>]*>support<\/th>/);
    expect(html).toContain("hold · group finance → allow");
    expect(html).toContain("Publish waits for admin");
    expect(html).toMatch(/<dt[^>]*>Checks<\/dt><dd[^>]*>pass<\/dd>/);
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Publish<\/button>/);
  });

  it("puts Publish in the Inbox, linking the change, with what it edits", async () => {
    const publish = await publishOf(runId);
    const { html } = await pageOf(app, `/inbox?approval=${encodeURIComponent(`${runId}/${publish.id}`)}`);
    expect(html).toMatch(new RegExp(`<dt[^>]*>Change</dt><dd[^>]*><a [^>]*href="/changes/rules"[^>]*>${TITLE}</a>`));
    expect(html).toMatch(
      /<ul aria-label="What the change edits"[^>]*><li>Policies <span[^>]*>1<\/span><\/li><li>People <span[^>]*>1<\/span>/,
    );
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Publish<\/button>/);
  });

  it("says on the Permissions page what the host enforces on main, either way", async () => {
    const { enforcement } = remote.host;
    try {
      expect((await pageOf(app, "/permissions")).html).toContain(
        "fakegit does not require a pull request or the sanoma check on main. a fake host enforces nothing",
      );
      remote.host.enforcement = async () => ({ pullRequest: true, check: true });
      const { html } = await pageOf(app, "/permissions");
      expect(html).toContain("fakegit requires a pull request and the sanoma check on main.");
      expect(html).not.toContain("Until then");
    } finally {
      remote.host.enforcement = enforcement;
    }
  });

  it("asks Publish again for a new commit on the draft, at its new head", async () => {
    const asked = await publishOf(runId);
    writeFileSync(join(draft.root, "NOTES.md"), "Admin says hello without waiting.\n");
    await draft.commit({ paths: ["NOTES.md"], message: "Say why", author: "alice" });
    // As the agent's turn tells it, once it commits.
    await tellCommits(client, "rules", { id: "alice" });
    const head = git("rev-parse", "draft/rules");
    await waitFor(
      () => client.approvals(runId),
      (approvals) =>
        approvals.some((a) => a.id === asked.id && a.status === "withdrawn") &&
        approvals.some((a) => a.status === "pending" && a.covers.includes(CHANGE_MERGE)),
    );
    expect((await client.change("rules"))!.state.head).toBe(head);
    expect((await remote.host.pullRequestFor("draft/rules"))!.head).toBe(head);
    const { html } = await pageOf(app, "/changes/rules");
    expect(html).toContain("Waiting for admin");
    expect(html).toContain(`<code>draft/rules</code> at <code title="${head}">${head.slice(0, 8)}</code>`);
    expect(html).toContain("NOTES.md</code>");
  });

  it("publishes as admin: the host squash-merges it, the page says Published, and the checkout follows main", async () => {
    const head = git("rev-parse", "draft/rules");
    await client.decide(runId, { decision: "approve", by: { id: "ada" } });
    const report = (await client.result(runId)) as { outcome: string; sha: string };
    expect(remote.merges).toEqual([{ number: 1, sha: head, method: "squash", title: `${TITLE} (#1)` }]);
    const merged = atOrigin("rev-parse", "main");
    expect(report).toMatchObject({ outcome: "merged", sha: merged });
    expect(atOrigin("log", "-1", "--format=%s", "main")).toBe(`${TITLE} (#1)`);

    const { html } = await pageOf(app, "/changes/rules");
    expect(html).toContain("Published");
    expect(html).toMatch(
      new RegExp(`<dt[^>]*>Merged</dt><dd[^>]*><code title="${merged}">${merged.slice(0, 8)}</code>`),
    );
    expect(html).toContain(`follows main at ${merged.slice(0, 8)}`);
    expect(html).not.toContain("Rejecting closes the change.");

    // The checkout followed: main is the squash, its files the draft's, and the draft is gone.
    expect(git("log", "-1", "--format=%H %s", "main")).toBe(`${merged} ${TITLE} (#1)`);
    expect(readFileSync(join(dir, "policies/hello.cedar"), "utf8")).toBe(ADMIN_SKIPS);
    expect(git("status", "--porcelain")).toBe("");
    expect(await source.drafts!()).toEqual([]);
  });

  it("closes a change its drafter rejects: the pull request closed, the page says Closed", async () => {
    await drafted("notes", "Say why in the README", { "README.md": "# Fixture Co\n\nHellos wait for finance.\n" });
    const { runId: notes } = await openChange({ client }, { id: "alice" }, "notes", app.url);
    await publishOf(notes);
    await client.decide(notes, { decision: "reject", by: { id: "alice" }, note: "Not yet" });
    expect(await client.result(notes)).toMatchObject({ outcome: "closed" });
    expect(remote.pullOf("draft/notes")!.state).toBe("closed");
    const { html } = await pageOf(app, "/changes/notes");
    expect(html).toContain("Closed by alice");
    expect(remote.merges).toHaveLength(1);
  });
});
