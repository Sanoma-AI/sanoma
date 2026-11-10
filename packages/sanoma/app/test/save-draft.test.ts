import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startTestWorker } from "sanoma/testing";
import { errorCode, memoryLedger, resolveConfig, SanomaClient, type SanomaConfig, type Worker } from "sanoma/workflows";
import { SAVE_DRAFT_WORKFLOW, undoDraftOf } from "sanoma/workflows/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { localGitSource } from "../../src/source.ts";
import { gitIdentity } from "../../test/git.ts";
import { freshDatabase } from "../../workflows/test/harness.ts";
import type { AppContext } from "../src/context.ts";
import { saveDraft, saves } from "../src/server/core.ts";
import { appSnapshot } from "../src/snapshot-build.ts";
import { appSteps } from "../src/steps/index.ts";
import { PEOPLE } from "./fixtures/change.ts";

// Saving a chat's draft on a repository with no remote a connector reviews changes on, end to end:
// the app's `saveDraft` starts the built-in, whose step (`steps/writes.ts`) merges the draft into a
// real checkout (`localGitSource`), closes it, pushes main to an origin when there is one, and asks
// the worker to reload; Undo saves a draft reverting it. Needs Postgres (`pnpm db:up`).

const databaseUrl = freshDatabase("save_draft");
const ORIGIN = "http://127.0.0.1:3000";
const WELCOME = "export const welcome = 1;\n";

let dir = "";
let gitConfig = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
let source: ReturnType<typeof localGitSource>;
let config: SanomaConfig;
let worker: Worker | undefined;
let client: SanomaClient;
let app: Pick<AppContext, "client" | "resolved" | "snapshot">;
let reloads = 0;

beforeAll(async () => {
  gitConfig = dirname(gitIdentity(vi.stubEnv).GIT_CONFIG_GLOBAL!);
  dir = mkdtempSync(join(tmpdir(), "sanoma-save-"));
  mkdirSync(join(dir, "resources"));
  writeFileSync(join(dir, "resources/people.ts"), PEOPLE);
  writeFileSync(join(dir, ".gitignore"), ".sanoma/\n");
  git("init", "--quiet", "--initial-branch=main");
  git("add", "--all");
  git("commit", "--quiet", "-m", "First");
  config = { workflows: [], connectors: [], root: dir, ledger: memoryLedger(), databaseUrl };
  source = localGitSource(dir, { databaseUrl });
  worker = await startTestWorker(config, { databaseUrl, source, app: appSteps, reload: () => void reloads++ });
  client = await SanomaClient.connect(config);
  app = { client, resolved: resolveConfig(config), snapshot: await appSnapshot(config, { source }) };
}, 120_000);

afterAll(async () => {
  await client?.close();
  await worker?.stop();
  vi.unstubAllEnvs();
  for (const at of [dir, gitConfig]) if (at) rmSync(at, { recursive: true, force: true });
});

/** Opens `person`'s chat `id` titled `title` (unless it is open), committing `files` on its draft: the draft's head. */
async function drafted(id: string, title: string, files: Record<string, string>, person = "alice") {
  if (!(await client.chats.get(id))) await client.chats.open({ id, person, engine: "loop", title });
  const draft = await source.draft!(id);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(draft.root, path)), { recursive: true });
    writeFileSync(join(draft.root, path), text);
  }
  await draft.commit({ paths: Object.keys(files), message: title, author: person });
  return (await source.diff!(id)).head;
}

/** The save run `runId`'s output, once it ends. */
const outcome = async (runId: string) => client.result(runId).catch((err: unknown) => err);

/** Starts the undo of `sha` by the chat `chat` as `startedBy` directly, past the app's own check; `n` (`~2`) runs it again. */
const undo = (sha: string, chat: string, startedBy: string, n = "") =>
  client.start(
    SAVE_DRAFT_WORKFLOW,
    { id: undoDraftOf(sha), title: "Undo", undo: sha, chat },
    { startedBy, runId: `save:${undoDraftOf(sha)}${n}` },
  );

describe("saving a chat's draft without a remote", () => {
  let revision = "";
  let welcomed = "";

  it("merges it into main as one commit titled as the chat, closes the draft, and reloads the worker", async () => {
    const head = await drafted("welcome", "Welcome a new client", { "workflows/welcome.ts": WELCOME });
    const { runId } = await saveDraft(app, { id: "alice" }, { id: "welcome", head }, ORIGIN);
    expect(runId).toBe("save:welcome");
    const saved = (await client.result(runId)) as { revision: string };
    expect(saved).toEqual({ revision: git("rev-parse", "main"), files: ["workflows/welcome.ts"], running: true });
    revision = saved.revision;
    expect(git("log", "-1", "--format=%an %s", "main")).toBe("alice via Sanoma Welcome a new client");
    expect(git("show", "main:workflows/welcome.ts")).toBe(WELCOME.trim());
    expect(await source.drafts!()).not.toContain("welcome");
    expect(reloads).toBe(1);
    const [listed] = await saves(app as AppContext, "welcome");
    expect(listed).toMatchObject({ runId, status: "finished", startedBy: { id: "alice" }, input: { head }, edits: [] });
    welcomed = head;
  });

  it("answers a step run again after its merge (a worker cut short) with that commit, opening no draft", async () => {
    let asked = 0;
    const step = {
      client,
      source,
      serially: <T>(write: () => Promise<T>) => write(),
      config,
      resolved: app.resolved,
      by: { id: "alice" },
      runId: "save:welcome",
      reload: () => void asked++,
    };
    const again = await appSteps.saveDraft(step, { id: "welcome", title: "Welcome a new client", head: welcomed });
    expect(again).toEqual({ revision, files: ["workflows/welcome.ts"], running: true });
    expect(asked).toBe(1);
    expect(await source.drafts!()).not.toContain("welcome");
    expect(git("rev-parse", "main")).toBe(revision);
  });

  it("refuses another person's chat, a draft moved on since its card, and a change to the people by anyone but admin", async () => {
    await drafted("bobs", "Bob's", { "notes.md": "bob\n" }, "bob");
    await expect(saveDraft(app, { id: "alice" }, { id: "bobs" }, ORIGIN)).rejects.toMatchObject({ status: 404 });
    const head = await drafted("moved", "Moved on", { "notes.md": "one\n" });
    await drafted("moved", "Moved on", { "notes.md": "two\n" });
    const { runId: stale } = await saveDraft(app, { id: "alice" }, { id: "moved", head }, ORIGIN);
    expect(await outcome(stale)).toMatchObject({
      message: "The draft has changed since: save it from its latest card",
    });
    const people = `${PEOPLE}export const bob = sanoma.person({ id: "bob" });\n`;
    const rules = await drafted("people", "Add Bob", { "resources/people.ts": people });
    const { runId: refused } = await saveDraft(app, { id: "alice" }, { id: "people", head: rules }, ORIGIN);
    const err = await outcome(refused);
    expect(errorCode(err)).toBe("not_approver");
    // Nothing merged; the drafts stay.
    expect(git("rev-parse", "main")).toBe(revision);
    expect(await source.drafts!()).toEqual(expect.arrayContaining(["moved", "people"]));
  });

  it("undoes it from a draft of its own, saved the same way; only a commit the chat saved", async () => {
    await expect(
      saveDraft(app, { id: "alice" }, { id: "welcome", undo: git("rev-parse", "main~1") }, ORIGIN),
    ).rejects.toMatchObject({ status: 409 });
    const { runId } = await saveDraft(app, { id: "alice" }, { id: "welcome", undo: revision }, ORIGIN);
    expect(runId).toBe(`save:${undoDraftOf(revision)}`);
    expect(await client.result(runId)).toMatchObject({ files: ["workflows/welcome.ts"], running: true });
    expect(git("log", "-1", "--format=%an %s", "main")).toBe("alice via Sanoma Undo Welcome a new client");
    expect(git("ls-tree", "--name-only", "-r", "main")).not.toContain("workflows/welcome.ts");
    expect(await source.drafts!()).not.toContain(undoDraftOf(revision));
    expect(reloads).toBe(2);
  });

  it("closes the undo's draft when the revert fails, so Undo can be asked again", async () => {
    const first = await drafted("greet", "Greet", { "notes/greet.md": "hello\n" });
    const { runId: saved } = await saveDraft(app, { id: "alice" }, { id: "greet", head: first }, ORIGIN);
    const { revision: greeted } = (await client.result(saved)) as { revision: string };
    const again = await drafted("greet-again", "Greet again", { "notes/greet.md": "hello again\n" });
    await client.result((await saveDraft(app, { id: "alice" }, { id: "greet-again", head: again }, ORIGIN)).runId);
    const { runId } = await saveDraft(app, { id: "alice" }, { id: "greet", undo: greeted }, ORIGIN);
    expect(await outcome(runId)).toMatchObject({ message: expect.stringContaining("cannot be undone here") });
    expect(await source.drafts!()).not.toContain(undoDraftOf(greeted));
  });

  it("undoes, however the run is started, only a commit a chat of the starter's saved", async () => {
    const before = git("rev-parse", "main");
    const first = git("rev-list", "--max-parents=0", "main");
    expect(await outcome(await undo(first, "welcome", "alice"))).toMatchObject({
      message: `${first.slice(0, 7)} is not a commit your chat welcome saved`,
    });
    expect(await outcome(await undo(revision, "welcome", "ada", "~9"))).toMatchObject({
      message: "No draft of yours is welcome",
    });
    expect(git("rev-parse", "main")).toBe(before);
    expect(await source.drafts!()).not.toContain(undoDraftOf(first));
  });

  it("pushes main to an origin no connector serves, and says when origin did not take it, the save standing", async () => {
    const remote = `${dir}-origin.git`;
    execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
    git("remote", "add", "origin", remote);
    try {
      const head = await drafted("pushed", "Pushed", { "notes/pushed.md": "pushed\n" });
      const { runId } = await saveDraft(app, { id: "alice" }, { id: "pushed", head }, ORIGIN);
      const pushed = (await client.result(runId)) as { revision: string };
      expect(pushed).toEqual({ revision: git("rev-parse", "main"), files: ["notes/pushed.md"], running: true });
      expect(execFileSync("git", ["rev-parse", "main"], { cwd: remote, encoding: "utf8" }).trim()).toBe(
        pushed.revision,
      );
      git("remote", "set-url", "origin", `${dir}-nowhere.git`);
      const next = await drafted("unpushed", "Unpushed", { "notes/unpushed.md": "unpushed\n" });
      const { runId: refused } = await saveDraft(app, { id: "alice" }, { id: "unpushed", head: next }, ORIGIN);
      expect(await client.result(refused)).toEqual({
        revision: git("rev-parse", "main"),
        files: ["notes/unpushed.md"],
        running: true,
        notPushed: expect.stringMatching(/^git push to origin failed: /),
      });
    } finally {
      git("remote", "remove", "origin");
      rmSync(remote, { recursive: true, force: true });
    }
  });
});
