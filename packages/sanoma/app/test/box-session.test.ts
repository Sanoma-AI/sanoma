import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { github } from "@sanoma-ai/connector-github";
import { pi } from "@sanoma-ai/connector-pi";
import { waitFor } from "sanoma/testing";
import { checkSandbox, fakeSandbox } from "sanoma/testing/sandbox";
import {
  type Box,
  type Chat,
  type ChatTurnContext,
  LOCAL_SANDBOX,
  resolveConfig,
  type Source,
  withSetup,
} from "sanoma/workflows";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acpEngine } from "../src/steps/agent/acp.ts";
import { NO_BOX } from "../src/lib/chat.ts";
import { boxSession, homeOf, personBox } from "../src/steps/agent/box-session.ts";
import { boxName } from "../src/steps/agent/checkout.ts";
import { harnessEngine } from "../src/steps/agent/harness.ts";
import { freePort, localBackend } from "../src/steps/agent/local-box.ts";

// The local backend's boxes, and the session `HarnessAgent` runs a coding agent in over one: their
// members on their own, no agent.

const base = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-session-")));
const root = join(base, "draft");
// The agents' state as `agentHome` lays it out: the boxes beside a person's own agents' installs
// and each person's sign-ins.
const agentHome = join(base, "agent-home");
const boxes = localBackend(join(agentHome, "boxes"));
const name = boxName("acme", "ada");
const home = join(agentHome, "boxes", name);
mkdirSync(join(root, "workflows"), { recursive: true });
mkdirSync(join(root, ".git"));
mkdirSync(join(root, "node_modules"));
mkdirSync(join(agentHome, "people/ada"), { recursive: true });
writeFileSync(join(agentHome, "people/ada/.credentials.json"), "{}");
mkdirSync(join(agentHome, "acp/opencode/node_modules"), { recursive: true });
mkdirSync(join(agentHome, "boxes/sanoma-acme-bob"), { recursive: true });
execFileSync("ln", ["-s", tmpdir(), join(root, "out")]);

let box: Box;
beforeAll(async () => {
  box = await boxes.open({ name });
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const session = (id = "s1") => boxSession(box, { id, root, home, ports: [4321] });

/** Whether a process `pid` is alive. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the local backend", () => {
  it("passes the sandbox conformance kit", async () => {
    const results = await checkSandbox({ backend: boxes, capabilities: LOCAL_SANDBOX, image: "", size: 0 });
    expect(results).toEqual([
      { name: "a box opens", ok: true },
      { name: "stdout arrives before the command exits", ok: true },
      { name: "stdin reaches cat", ok: true },
      { name: "a written file reads back, and runs with its mode", ok: true },
      { name: "a file and the home directory survive a stop and the next open", ok: true },
      { name: "an exposed port answers from outside the box", ok: true },
      { name: "a command killed mid-run exits non-zero", ok: true },
      { name: "discard leaves the next open empty", ok: true },
    ]);
  });

  it("names a box by the company and the person, escaped as a directory, and keeps it under its own directory", async () => {
    expect(boxName("@acme", "Ada.Lovelace")).toBe("sanoma-%40acme-%41da%2E%4Covelace");
    expect(boxName("acme-ada", "x")).not.toBe(boxName("acme", "ada-x"));
    expect(await homeOf(box)).toBe(home);
    for (const bad of ["../out", ".hidden", ""]) {
      await expect(boxes.open({ name: bad }), bad).rejects.toThrow(/no box's name/);
    }
  });
});

describe("boxSession over a local box", () => {
  it("runs commands in bash, in the checkout, with its own environment and none of this process's", async () => {
    process.env.SANOMA_SESSION_SECRET = "from this process";
    try {
      const ran = await session().run({ command: "set -o pipefail; pwd; env", env: { WORK_DIR: "x" } });
      expect(ran.exitCode).toBe(0);
      const [cwd, ...env] = ran.stdout.trim().split("\n");
      expect(cwd).toBe(root);
      const names = env
        .map((line) => line.split("=")[0])
        .filter((variable) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(variable!));
      expect(names.toSorted()).toEqual([
        "COREPACK_ENABLE_DOWNLOAD_PROMPT",
        "COREPACK_HOME",
        "HOME",
        "LANG",
        "PATH",
        "WORK_DIR",
      ]);
      expect(env).toContain(`HOME=${home}`);
      expect(ran.stdout).not.toContain("from this process");
    } finally {
      delete process.env.SANOMA_SESSION_SECRET;
    }
  });

  it("reaches its bridge on loopback, on the port it leases", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    const local = boxSession(box, { id: "p", root, home, ports: [port] });
    expect(local.ports).toEqual([port]);
    expect(await local.getPortEndpoint({ port, protocol: "ws" })).toEqual({ url: `ws://127.0.0.1:${port}` });
    expect(await local.getPortEndpoint({ port })).toEqual({ url: `http://127.0.0.1:${port}` });
  });

  it("confines its files to the checkout by the checkout rule, and to its home", async () => {
    const local = session();
    await local.writeTextFile({ path: "workflows/new.ts", content: "export {};\n" });
    expect(readFileSync(join(root, "workflows/new.ts"), "utf8")).toBe("export {};\n");
    expect(await local.readTextFile({ path: join(root, "workflows/new.ts"), startLine: 1, endLine: 1 })).toBe(
      "export {};",
    );
    await local.writeTextFile({ path: join(home, ".ai-sdk-harness/x.json"), content: "{}" });
    expect(await local.readTextFile({ path: join(home, ".ai-sdk-harness/x.json") })).toBe("{}");
    expect(await local.readTextFile({ path: "workflows/missing.ts" })).toBeNull();
    // Its own run files, but not another session's, whose bridge's start config holds the key.
    const runs = join(home, ".ai-sdk-harness/.agent-runs");
    await local.writeTextFile({ path: join(runs, "s1/x.json"), content: "{}" });
    mkdirSync(join(runs, "s2"), { recursive: true });
    writeFileSync(join(runs, "s2/start-config.json"), "{}");
    for (const path of [
      join(runs, "s2/start-config.json"),
      join(home, ".ai-sdk-harness/.AGENT-RUNS/s2/start-config.json"),
    ]) {
      await expect(local.readTextFile({ path }), path).rejects.toThrow(/outside the checkout/);
    }
    for (const path of ["../outside.txt", "/etc/passwd", "out/x", ".git/config", "node_modules/x/index.js"]) {
      await expect(local.writeTextFile({ path, content: "no" }), path).rejects.toThrow(/outside the checkout/);
      await expect(local.readBinaryFile({ path }), path).rejects.toThrow(/outside the checkout/);
    }
    expect(existsSync(join(base, "outside.txt"))).toBe(false);
  });

  it("holds a checkout inside its home (the box's clone) to the checkout rule, not the home's", async () => {
    const clone = join(home, "repo");
    mkdirSync(join(clone, ".git"), { recursive: true });
    mkdirSync(join(clone, "node_modules"), { recursive: true });
    execFileSync("ln", ["-s", join(clone, ".git"), join(home, "git-link")]);
    const local = boxSession(box, { id: "c", root: clone, home, ports: [] });
    await local.writeTextFile({ path: "workflows/new.ts", content: "export {};\n" });
    expect(readFileSync(join(clone, "workflows/new.ts"), "utf8")).toBe("export {};\n");
    for (const path of [".git/sanoma-head", join(clone, "node_modules/x.js"), join(home, "git-link/config")]) {
      await expect(local.writeTextFile({ path, content: "no" }), path).rejects.toThrow(/outside the checkout/);
    }
    // The rest of its home is still its own.
    await local.writeTextFile({ path: join(home, ".pi/agent/settings.json"), content: "{}" });
    expect(existsSync(join(home, ".pi/agent/settings.json"))).toBe(true);
  });

  it("never reaches another person's box, a person's own-agent sign-ins or the own agents' installs beside its home", async () => {
    const local = session();
    // A link in its home leads nowhere else.
    execFileSync("ln", ["-s", join(agentHome, "people/ada"), join(home, "ada")]);
    for (const path of [
      join(agentHome, "people/ada/.credentials.json"),
      join(home, "../../people/ada/.credentials.json"),
      join(home, "ada/.credentials.json"),
      join(home, "../sanoma-acme-bob/.ai-sdk-harness/x.json"),
    ]) {
      await expect(local.readTextFile({ path }), path).rejects.toThrow(/outside the checkout/);
    }
    for (const path of [join(agentHome, "acp/opencode/node_modules/x.js"), join(home, "../../acp/shims/gh")]) {
      await expect(local.writeTextFile({ path, content: "no" }), path).rejects.toThrow(/outside the checkout/);
    }
    expect(existsSync(join(agentHome, "acp/opencode/node_modules/x.js"))).toBe(false);
    expect(existsSync(join(agentHome, "acp/shims"))).toBe(false);
  });

  it("kills each command's whole process group, and deletes only its own .agent-runs, when destroyed", async () => {
    const runs = join(home, ".ai-sdk-harness/.agent-runs");
    mkdirSync(join(runs, "s1/bridge"), { recursive: true });
    writeFileSync(join(runs, "s1/bridge/start-config.json"), "{}");
    mkdirSync(join(runs, "other"), { recursive: true });
    const local = session("s1");
    // A bridge as an adapter starts one: a shell whose child outlives it.
    const started = await local.spawn({ command: "sleep 300 & echo $!; wait" });
    const reader = started.stdout.getReader();
    const pid = Number(new TextDecoder().decode((await reader.read()).value).trim());
    reader.releaseLock();
    expect(alive(pid)).toBe(true);
    await local.destroy();
    await waitFor(() => !alive(pid), Boolean, 5000);
    expect(await started.wait()).toEqual({ exitCode: 1 });
    expect(existsSync(join(runs, "s1"))).toBe(false);
    expect(existsSync(join(runs, "other"))).toBe(true);
  });
});

/** A live instance's database: not this computer's (`placeOf`). */
const LIVE = "postgresql://sanoma@db.example.com/acme";

/** A company's root named acme, with `files` written. */
function company(files: Record<string, string> = {}) {
  const at = mkdtempSync(join(base, "company-"));
  writeFileSync(join(at, "package.json"), '{ "name": "acme", "private": true, "type": "module" }\n');
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(at, file, ".."), { recursive: true });
    writeFileSync(join(at, file), text);
  }
  return at;
}

describe("personBox", () => {
  const by = { id: "ada" };

  it("opens the declared sandbox's box through its connector's backend, given its fields, image and size, on a live instance too", async () => {
    const fake = fakeSandbox(join(base, "declared"));
    const opened: unknown[] = [];
    const connector = withSetup(fake.connector, {
      sandbox: ({ declared }) => ({
        ...fake.backend,
        open: (opts) => {
          opened.push({ ...opts, declared });
          return fake.backend.open(opts);
        },
      }),
    });
    const declaring = company({
      "resources/infra.ts":
        'import { testsandbox } from "@sanoma-ai/testing-sandbox/resources";\nexport const box = testsandbox.box({ name: "box", image: "node:26", size: 2 });\n',
    });
    const resolved = resolveConfig({ workflows: [], connectors: [connector], root: declaring, databaseUrl: LIVE });
    const chosen = await personBox({ resolved, by, client: undefined as never });
    expect(chosen.name).toBe(boxName("acme", "ada"));
    const opening = await chosen.open();
    expect(await homeOf(opening)).toBe(join(fake.root, chosen.name));
    expect(opened).toEqual([
      { name: chosen.name, image: "node:26", size: 2, declared: { name: "box", image: "node:26", size: 2 } },
    ]);
  });

  it("opens the local backend's box under the repository's .sanoma when none is declared, on this computer", async () => {
    const resolved = resolveConfig({ workflows: [], connectors: [], root: company() });
    const draft = { root: base, draft: () => undefined, diff: () => undefined } as unknown as Source;
    const chosen = await personBox({ resolved, by, client: undefined as never, source: draft });
    expect(await homeOf(await chosen.open())).toBe(join(base, ".sanoma/agent-home/boxes", boxName("acme", "ada")));
  });

  it("refuses both engines' turns on a live instance that declares none, saying what to declare, before any draft", async () => {
    // Pi's and Copilot's connectors, which give the engines their agents.
    const resolved = resolveConfig({ workflows: [], connectors: [pi, github], root: company(), databaseUrl: LIVE });
    await expect(personBox({ resolved, by, client: undefined as never })).rejects.toThrow(NO_BOX);
    expect(NO_BOX).toBe(
      "Coding agents work in a box of their own on a live instance, and this company declares none: declare one in resources/sanoma/infra.ts (`export const box = agent37.instance({})`, with the agent37 connector in sanoma.config.ts) and set AGENT37_API_KEY [connector:agent37]",
    );
    const step = { resolved, by, signal: new AbortController().signal } as unknown as ChatTurnContext;
    const turn = { step, chat: { id: "c" } as Chat, messages: [] };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const stream of [harnessEngine("pi")(turn), acpEngine("copilot")(turn)]) {
        const errors: string[] = [];
        for await (const chunk of stream) if (chunk.type === "error") errors.push(chunk.errorText);
        expect(errors).toEqual([NO_BOX]);
      }
    } finally {
      error.mockRestore();
    }
  });
});
