import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startTestWorker } from "sanoma/testing";
import { errorCode, memoryLedger, resolveConfig, SanomaClient, type SanomaConfig, type Worker } from "sanoma/workflows";
import { undoDraftOf } from "sanoma/workflows/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { localGitSource } from "../../src/source.ts";
import { gitIdentity } from "../../test/git.ts";
import { freshDatabase } from "../../workflows/test/harness.ts";
import type { AppContext } from "../src/context.ts";
import { saveDraft, saves } from "../src/server/core.ts";
import { appSnapshot } from "../src/snapshot-build.ts";
import { appSteps } from "../src/steps/index.ts";
import { PEOPLE } from "./fixtures/change.ts";

// Saving a chat's draft on a repository with no remote, end to end: the app's `saveDraft` starts
// the built-in, whose step (`steps/writes.ts`) merges the draft into a real checkout
// (`localGitSource`), closes it, and asks the worker to reload; Undo saves a draft reverting it.
// Needs Postgres (`pnpm db:up`).

const databaseUrl = freshDatabase("save_draft");
const ORIGIN = "http://127.0.0.1:3000";
const WELCOME = "export const welcome = 1;\n";

let dir = "";
let gitConfig = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
let source: ReturnType<typeof localGitSource>;
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
  const config: SanomaConfig = { workflows: [], connectors: [], root: dir, ledger: memoryLedger(), databaseUrl };
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

describe("saving a chat's draft without a remote", () => {
  let revision = "";

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
});
