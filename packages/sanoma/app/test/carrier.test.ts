import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSandbox } from "sanoma/testing/sandbox";
import { type Box, resolveConfig, type Source } from "sanoma/workflows";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFixture, ensureBuilt, FIXTURE_GRID, installInClone } from "../../test/fixture.ts";
import { gitIdentity } from "../../test/git.ts";
import { localGitSource } from "../../src/source.ts";
import { checkDraft, homeOf } from "../src/steps/agent/box-session.ts";
import { BOX_BUSY, boxTurn, carryIn, carryOut, OWN_PNPM } from "../src/steps/agent/carrier.ts";
import { boxName } from "../src/steps/agent/checkout.ts";
import { localBackend } from "../src/steps/agent/local-box.ts";

// Git between the live instance and a person's box (`carrier.ts`), over the fake sandbox and the
// app's local backend: a draft carried into the box's clone and its commits back, nothing of the
// repository's remote or the company's secrets in the box, a box that dies mid-turn, two turns in
// one box at once, the clone's install, and `sanoma check` in the box (`checkDraft`, `checkIn`).

/** What must never reach a box: the remote's token, the company's secret. */
const TOKEN = "ghs_carrier-test-token-value";
const SECRET = "sk-company-secret-value";

let dir = "";
let sandbox: ReturnType<typeof fakeSandbox>;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const opening = { name: "sanoma-acme-ada", image: "node", size: 1 };
/** The turn's commit, as the harness makes it. */
const turn = { message: "Pi: Add a laptop step", author: "ada" };

beforeEach(() => {
  gitIdentity(vi.stubEnv);
  vi.stubEnv("GITHUB_TOKEN", TOKEN);
  vi.stubEnv("ANTHROPIC_API_KEY", SECRET);
  dir = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-carrier-")));
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(dir, ".gitignore"), ".sanoma/\nnode_modules/\n.env\n");
  writeFileSync(join(dir, ".env"), `ANTHROPIC_API_KEY=${SECRET}\n`);
  writeFileSync(join(dir, "offboarding.ts"), "export const steps = ['accounts'];\n");
  git("add", "--all");
  git("commit", "--quiet", "-m", "First");
  // The worst a remote can be: its token in its URL.
  git("remote", "add", "origin", `https://x-access-token:${TOKEN}@github.com/acme/company.git`);
  sandbox = fakeSandbox();
});
afterEach(() => {
  vi.unstubAllEnvs();
  sandbox.remove();
  rmSync(dir, { recursive: true, force: true });
});

/** Every file under `at`, links not followed. */
const files = (at: string): string[] =>
  readdirSync(at, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

/** What `command` prints in `box`. */
async function inBox(box: Box, command: string, cwd?: string) {
  const ran = await box.run(command, cwd === undefined ? {} : { cwd });
  const [out, { exitCode }] = await Promise.all([new Response(ran.stdout).text(), ran.wait()]);
  expect(exitCode, command).toBe(0);
  return out.trim();
}

describe("the carrier", () => {
  it("carries the draft into the box's clone and the box's commits back, and nothing of the remote or the company's secrets", async () => {
    const source = localGitSource(dir);
    const draft = await source.draft!("d1");
    const before = await source.head(draft.branch);
    let root = "";
    const moved = await boxTurn(
      opening.name,
      () => sandbox.backend.open(opening),
      async (box) => {
        const home = await homeOf(box);
        const carried = await carryIn(box, source, "d1", { home });
        root = carried.root;
        expect(carried).toEqual({ root: join(home, "repo"), head: before });
        expect(
          await inBox(box, "git branch --show-current; git remote; git config --get-regexp '^remote' || true", root),
        ).toBe("draft/d1");
        expect(readFileSync(join(root, "offboarding.ts"), "utf8")).toContain("accounts");
        // The agent's edit, in the box.
        writeFileSync(join(root, "offboarding.ts"), "export const steps = ['accounts', 'laptop'];\n");
        writeFileSync(join(root, "laptop.ts"), "export const laptop = true;\n");
        // Git settings the agent wrote in the box's home run nothing when the box commits.
        writeFileSync(join(home, "fsmonitor"), `#!/bin/sh\ntouch "${join(home, "ran")}"\n`, { mode: 0o755 });
        writeFileSync(join(home, ".gitconfig"), `[core]\n\tfsmonitor = ${join(home, "fsmonitor")}\n`);
        expect(await carryOut(box, source, "d1", { since: carried.head, ...turn })).toBe(true);
        expect(existsSync(join(home, "ran"))).toBe(false);
        // The box's whole environment, as a command there sees it.
        const env = await inBox(box, "env");
        expect(env).not.toContain(TOKEN);
        expect(env).not.toContain(SECRET);
        return true;
      },
    );
    expect(moved).toBe(true);

    // One commit, the person's through Sanoma, in the draft's checkout; the live checkout left alone.
    expect(git("log", "--format=%an|%s", draft.branch)).toBe("ada via Sanoma|Pi: Add a laptop step\nTest User|First");
    expect(readFileSync(join(draft.root, "laptop.ts"), "utf8")).toBe("export const laptop = true;\n");
    expect(git("-C", draft.root, "status", "--porcelain")).toBe("");
    expect(git("status", "--porcelain")).toBe("");
    expect(await source.diff!("d1")).toMatchObject({ files: ["laptop.ts", "offboarding.ts"] });

    // No file in the box holds the token, the remote's URL or the secret.
    const held = files(sandbox.root).filter((file) => {
      const text = readFileSync(file, "latin1");
      return text.includes(TOKEN) || text.includes("github.com/acme") || text.includes(SECRET);
    });
    expect(held).toEqual([]);

    // The next turn: our loop's commit on the draft meanwhile arrives; a turn that changes nothing brings none back.
    writeFileSync(join(draft.root, "notes.md"), "Laptops go back to IT.\n");
    await draft.commit({ paths: ["notes.md"], message: "Notes", author: "ada" });
    await boxTurn(
      opening.name,
      () => sandbox.backend.open(opening),
      async (box) => {
        const { head } = await carryIn(box, source, "d1", { home: await homeOf(box) });
        expect(head).toBe(await source.head(draft.branch));
        expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("Laptops go back to IT.\n");
        expect(await carryOut(box, source, "d1", { since: head, ...turn })).toBe(false);
      },
    );
    expect(git("log", "-1", "--format=%s", draft.branch)).toBe("Notes");
  });

  it("ends a turn whose box died with an error that says so, and starts the next from the draft again", async () => {
    const source = localGitSource(dir);
    const draft = await source.draft!("d2");
    const head = await source.head(draft.branch);
    // A box that dies mid-turn, its disk with it.
    await expect(
      boxTurn(
        opening.name,
        () => sandbox.backend.open(opening),
        async (box) => {
          const carried = await carryIn(box, source, "d2", { home: await homeOf(box) });
          writeFileSync(join(carried.root, "lost.ts"), "export {};\n");
          await sandbox.backend.discard(opening);
          await carryOut(box, source, "d2", { since: carried.head, ...turn });
        },
      ),
    ).rejects.toThrow(/could not be brought back from your box, so they are lost/);
    expect(await source.head(draft.branch)).toBe(head);

    // One that died with its disk kept, an edit left uncommitted: the next turn starts clean from the draft.
    await boxTurn(
      opening.name,
      () => sandbox.backend.open(opening),
      async (box) => {
        const carried = await carryIn(box, source, "d2", { home: await homeOf(box) });
        writeFileSync(join(carried.root, "offboarding.ts"), "broken(\n");
        writeFileSync(join(carried.root, "stray.ts"), "export {};\n");
      },
    );
    await boxTurn(
      opening.name,
      () => sandbox.backend.open(opening),
      async (box) => {
        const carried = await carryIn(box, source, "d2", { home: await homeOf(box) });
        expect(carried.head).toBe(head);
        expect(await inBox(box, "git status --porcelain", carried.root)).toBe("");
        expect(existsSync(join(carried.root, "stray.ts"))).toBe(false);
        expect(existsSync(join(carried.root, "lost.ts"))).toBe(false);
      },
    );
  });

  it("takes the whole branch when the clone lacks the head it says it has, runs none of the clone's own hooks, carries edits off the draft's branch, refuses a rewritten history, and cleans what another draft left", async () => {
    const source = localGitSource(dir);
    const draft = await source.draft!("d3");
    let root = "";
    await boxTurn(
      opening.name,
      () => sandbox.backend.open(opening),
      async (box) => {
        ({ root } = await carryIn(box, source, "d3", { home: await homeOf(box) }));
      },
    );
    // What an agent with a terminal can do to the clone's git: a hook, and a known head it lacks.
    writeFileSync(
      join(root, ".git/hooks/post-checkout"),
      `#!/bin/sh
touch "${join(root, "..", "ran")}"
`,
      {
        mode: 0o755,
      },
    );
    writeFileSync(join(draft.root, "notes.md"), "Laptops go back to IT.\n");
    await draft.commit({ paths: ["notes.md"], message: "Notes", author: "ada" });
    const notes = await source.head(draft.branch);
    writeFileSync(join(root, ".git/sanoma-head"), notes);
    await boxTurn(
      opening.name,
      () => sandbox.backend.open(opening),
      async (box) => {
        const carried = await carryIn(box, source, "d3", { home: await homeOf(box) });
        expect(carried.head).toBe(notes);
        expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("Laptops go back to IT.\n");
        expect(existsSync(join(root, "..", "ran"))).toBe(false);
        // Edits on a branch of the agent's own, or a detached head, are the draft's.
        await inBox(box, "git checkout --quiet -b fix && git checkout --quiet --detach", root);
        writeFileSync(join(root, "offboarding.ts"), "export const steps = [];\n");
        expect(await carryOut(box, source, "d3", { since: carried.head, ...turn })).toBe(true);
      },
    );
    expect(readFileSync(join(draft.root, "offboarding.ts"), "utf8")).toBe("export const steps = [];\n");
    const edited = await source.head(draft.branch);
    await boxTurn(
      opening.name,
      () => sandbox.backend.open(opening),
      async (box) => {
        const carried = await carryIn(box, source, "d3", { home: await homeOf(box) });
        // A history that no longer holds the head given is refused, never dropped unsaid.
        await inBox(box, "git reset --quiet --hard HEAD~1", root);
        writeFileSync(join(root, "offboarding.ts"), "export const steps = [1];\n");
        await expect(carryOut(box, source, "d3", { since: carried.head, ...turn })).rejects.toThrow(
          /could not be brought back from your box, so they are lost.*the agent rewrote the branch's history/s,
        );
      },
    );
    expect(await source.head(draft.branch)).toBe(edited);

    // What a turn left that the repository ignores: kept for its draft, gone from another draft's turn, the install but kept.
    writeFileSync(join(root, ".env"), "LEFT=1\n");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules/kept.js"), "");
    await source.draft!("d4");
    const open = () => sandbox.backend.open(opening);
    await boxTurn(opening.name, open, async (box) => {
      await carryIn(box, source, "d3", { home: await homeOf(box) });
      expect(existsSync(join(root, ".env"))).toBe(true);
      await carryIn(box, source, "d4", { home: await homeOf(box) });
      expect(existsSync(join(root, ".env"))).toBe(false);
      expect(existsSync(join(root, "node_modules/kept.js"))).toBe(true);
    });
  });

  it("refuses a second turn in a box while one runs there, and stops the box at each turn's end however it ends", async () => {
    const stopped: string[] = [];
    const backend = {
      ...sandbox.backend,
      async open(opts: typeof opening) {
        const box = await sandbox.backend.open(opts);
        return { ...box, stop: async () => void stopped.push(opts.name) };
      },
    };
    let release: (() => void) | undefined;
    const first = boxTurn(
      opening.name,
      () => backend.open(opening),
      () => new Promise<void>((done) => (release = done)),
    );
    await expect(
      boxTurn(
        opening.name,
        () => backend.open(opening),
        async () => "second",
      ),
    ).rejects.toThrow(BOX_BUSY);
    // Another person's box is free.
    expect(
      await boxTurn(
        "sanoma-acme-bob",
        () => backend.open({ ...opening, name: "sanoma-acme-bob" }),
        async () => "bob",
      ),
    ).toBe("bob");
    // A check waits for the box instead, and runs once the turn ends.
    const order: string[] = [];
    const check = boxTurn(
      opening.name,
      () => backend.open(opening),
      async () => void order.push("check"),
      { wait: true },
    );
    await vi.waitFor(() => expect(release).toBeDefined());
    order.push("turn ends");
    release!();
    await Promise.all([first, check]);
    expect(order).toEqual(["turn ends", "check"]);
    await expect(
      boxTurn(
        opening.name,
        () => backend.open(opening),
        async () => {
          throw new Error("the agent failed");
        },
      ),
    ).rejects.toThrow("the agent failed");
    expect(
      await boxTurn(
        opening.name,
        () => backend.open(opening),
        async () => "again",
      ),
    ).toBe("again");
    expect(stopped).toEqual(["sanoma-acme-bob", opening.name, opening.name, opening.name, opening.name]);
  });

  it("refuses to carry a draft for a repository that cannot", async () => {
    const box = await sandbox.backend.open(opening);
    const plain: Source = { root: dir, commit: () => undefined, head: () => "x" };
    await expect(carryIn(box, plain, "d", { home: "/home" })).rejects.toThrow(/cannot carry a draft/);
  });
});

describe("the clone's install", () => {
  it("installs with the lockfile on the first open and again only when the lockfile changed or the install is gone, and goes on when it fails", async () => {
    // A company with nothing to install but its lockfile, on the app's local backend, whose
    // `packageManager` names another pnpm (an agent may write one): the box's own installs.
    writeFileSync(join(dir, "package.json"), '{ "name": "acme", "private": true, "packageManager": "pnpm@10.0.0" }\n');
    const lockfile =
      "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n";
    writeFileSync(join(dir, "pnpm-lock.yaml"), lockfile);
    git("add", "--all");
    git("commit", "--quiet", "-m", "Lockfile");
    const source = localGitSource(dir);
    const draft = await source.draft!("d3");
    const boxes = localBackend(join(dir, ".sanoma/agent-home/boxes"));
    const open = () =>
      boxTurn(
        opening.name,
        () => boxes.open(opening),
        async (box) => (await carryIn(box, source, "d3", { home: await homeOf(box) })).root,
      );
    const root = await open();
    const installed = join(root, "node_modules");
    expect(existsSync(installed)).toBe(true);
    // The box's own pnpm, in the clone as in its home.
    const box = await boxes.open(opening);
    const pnpm = async (cwd: string) => {
      const ran = await box.run("pnpm --version", { cwd, env: OWN_PNPM });
      return (await new Response(ran.stdout).text()).trim();
    };
    expect(await pnpm(root)).toBe(await pnpm("."));
    expect(await pnpm(root)).not.toBe("10.0.0");
    // The same lockfile: no install (pnpm would write its state again).
    const state = join(installed, ".pnpm-workspace-state-v1.json");
    rmSync(state);
    await open();
    expect(existsSync(state)).toBe(false);
    // An install that is gone is made again.
    rmSync(installed, { recursive: true });
    await open();
    expect(existsSync(state)).toBe(true);
    // A changed lockfile installs again.
    writeFileSync(join(draft.root, "pnpm-lock.yaml"), `${lockfile}\n`);
    await draft.commit({ paths: ["pnpm-lock.yaml"], message: "Lockfile again", author: "ada" });
    await open();
    expect(existsSync(installed)).toBe(true);
    // One that fails is logged, and the turn goes on: its agent cannot run one.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(
      join(draft.root, "package.json"),
      '{ "name": "acme", "private": true, "dependencies": { "x": "1" } }\n',
    );
    // Its lockfile changed too, but lacks the dependency.
    writeFileSync(join(draft.root, "pnpm-lock.yaml"), `${lockfile}\n\n`);
    await draft.commit({ paths: ["package.json", "pnpm-lock.yaml"], message: "A dependency", author: "ada" });
    // Without pnpm's own record of an install it found up to date.
    rmSync(installed, { recursive: true });
    expect(await open()).toBe(root);
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/the install in the box .* failed/), expect.any(String));
    logged.mockRestore();
  }, 120_000);
});

describe("the check in a person's box", () => {
  it("checks each draft in the box's clone, one at a time, with every field of its result, on a Postgres of its own, and nothing of this instance's", async () => {
    // The fixture company in a git repository of its own, on the packages' builds (made when stale):
    // its install given to the box's clone, as the box's own install of a lockfile would make it.
    ensureBuilt();
    const company = copyFixture();
    const at = (...args: string[]) => execFileSync("git", args, { cwd: company, encoding: "utf8" }).trim();
    try {
      writeFileSync(join(company, ".gitignore"), ".sanoma/\nnode_modules/\n");
      at("init", "--quiet", "--initial-branch=main");
      at("add", "--all");
      at("commit", "--quiet", "-m", "First");
      const source = localGitSource(company);
      const [, broken, unloadable] = await Promise.all([
        source.draft!("ok"),
        source.draft!("broken"),
        source.draft!("unloadable"),
      ]);
      writeFileSync(join(broken.root, "workflows", "broken.ts"), 'export const n: number = "one";\n');
      // Its config prints a passing result as it loads, which does not pass it: the launcher's comes last.
      const fake = JSON.stringify({ sanoma: 1, event: "checked", ok: true, problems: [], warnings: [] });
      const config = join(broken.root, "sanoma.config.ts");
      writeFileSync(config, `console.log(${JSON.stringify(fake)});\n${readFileSync(config, "utf8")}`);
      await broken.commit({ paths: ["workflows/broken.ts", "sanoma.config.ts"], message: "Break", author: "agent" });
      // A config that does not load, and says what the check's environment holds.
      const says = 'throw new Error(`no config; env ${Object.keys(process.env).sort().join(" ")}`);\n';
      writeFileSync(join(unloadable.root, "sanoma.config.ts"), says);
      await unloadable.commit({ paths: ["sanoma.config.ts"], message: "Unload", author: "agent" });
      // Neither this process's database nor its credentials reach the check.
      vi.stubEnv("SANOMA_DATABASE_URL", "postgresql://postgres:dbos@localhost:5433/not_for_the_check");
      vi.stubEnv("GHOST_ADMIN_API_KEY", "not-for-the-check");

      // The local box of a person on this computer, as Publish and our loop's run_checks check in it.
      const resolved = resolveConfig({ workflows: [], connectors: [], root: company });
      const step = { source, resolved, by: { id: "ada" }, client: undefined as never };
      const home = join(company, ".sanoma/agent-home/boxes", boxName(resolved.appName, "ada"));
      const clone = join(home, "repo");
      installInClone(company, clone);
      const [passed, failed, refused] = await Promise.all([
        checkDraft(step, { id: "ok" }),
        checkDraft(step, { id: "broken" }),
        checkDraft(step, { id: "unloadable" }),
      ]);
      // The grid comes back as the check reported it: the fixture has no policies, so all allow.
      expect(passed).toEqual({ ok: true, problems: [], warnings: [], grid: FIXTURE_GRID });
      expect(failed.ok).toBe(false);
      expect(failed.problems).toContainEqual(
        expect.stringMatching(/^workflows\/broken\.ts:1:14: .*'string'.*'number'/),
      );
      expect(refused).toEqual({
        ok: false,
        problems: [expect.stringMatching(/^sanoma check: .*no config; env /)],
        warnings: [],
      });
      const names = refused.problems[0]!.split("no config; env ")[1]!.split(" ");
      expect(names).toEqual(expect.arrayContaining(["HOME", "PATH", "SANOMA_EVENTS"]));
      expect(names.filter((name) => /DATABASE|GHOST/.test(name))).toEqual([]);
      // On a Postgres of its own (no URL reached it): this platform's server, under the box's home.
      const cache = join(home, process.platform === "darwin" ? "Library/Caches" : ".cache", "sanoma/postgres");
      expect(readdirSync(cache)).toHaveLength(1);

      // A draft that cannot be carried in is a result of one problem, saying why.
      expect(await checkDraft(step, { id: "never" })).toEqual({
        ok: false,
        problems: [expect.stringMatching(/^sanoma check: The draft could not be brought into your box/)],
        warnings: [],
      });
      expect((await checkDraft(step, { id: "../escape" })).problems).toEqual([expect.stringMatching(/A draft's id/)]);
      // What the check wrote in the clone is never brought back: the next turn's carry finds nothing.
      await boxTurn(
        "check",
        () => localBackend(join(company, ".sanoma/agent-home/boxes")).open({ name: boxName(resolved.appName, "ada") }),
        async (box) => {
          const { head } = await carryIn(box, source, "ok", { home });
          expect(await carryOut(box, source, "ok", { since: head, ...turn })).toBe(false);
        },
      );
      // The live checkout as it was.
      expect(await source.drafts!()).toEqual(["broken", "ok", "unloadable"]);
      expect(at("status", "--porcelain")).toBe("");
      expect(at("log", "--format=%s")).toBe("First");
    } finally {
      rmSync(company, { recursive: true, force: true });
    }
  }, 600_000);
});
