import { execFileSync, spawn, spawnSync } from "node:child_process";
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
import { anthropic } from "@sanoma-ai/connector-anthropic";
import { type Box, resolveConfig } from "sanoma/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { install, ownAgent, shims } from "../src/steps/agent/acp.ts";
import { boxSession, homeOf } from "../src/steps/agent/box-session.ts";
import { localBackend } from "../src/steps/agent/local-box.ts";

// What a person's own agent finds in their box (a local backend's): the shims first on its PATH
// (`shims` in acp.ts), run as the agent runs them: `gh`, `open` and `xdg-open` refuse; `security`
// is a Keychain that is there, empty, and takes nothing, so Claude Code keeps its sign-in in its
// own file under its HOME, `.acp` in the box; and its install (`install`), there. With SANOMA_LIVE=1
// on macOS, Claude Code itself, installed, stores a secret through the shims.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-shims-")));
let box: Box;
let home = "";
/** The person's own agents' HOME in the box. */
let agents = "";
let dir = "";
mkdirSync(join(scratch, "draft"));

beforeAll(async () => {
  box = await localBackend(join(scratch, "boxes")).open({ name: "sanoma-acme-ada" });
  home = await homeOf(box);
  agents = join(home, ".acp");
  dir = await shims(box, agents);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Runs the shim `name` with `args` (and `input` on its stdin): its exit and what it printed. */
const run = (name: string, args: string[], input?: string) => {
  const { status, stdout, stderr } = spawnSync(join(dir, name), args, { input, encoding: "utf8", timeout: 5_000 });
  return { status, stdout, stderr };
};

describe("a person's own agent's shims", () => {
  it("are .acp/shims in the box, and refuse gh, open and xdg-open", () => {
    expect(dir).toBe(join(scratch, "boxes/sanoma-acme-ada/.acp/shims"));
    expect(readdirSync(dir).toSorted()).toEqual(["gh", "open", "security", "xdg-open"]);
    for (const [name, args] of [
      ["gh", ["auth", "token"]],
      ["open", ["https://example.test"]],
      ["xdg-open", ["https://example.test"]],
    ] as const) {
      expect(run(name, [...args])).toEqual({
        status: 1,
        stdout: "",
        stderr: `${name} is not available to a person's own agent in Sanoma\n`,
      });
    }
  });

  it("are out of a company-key session's reach in the same box", async () => {
    const session = boxSession(box, { id: "s1", root: join(scratch, "draft"), home, ports: [] });
    await expect(session.readTextFile({ path: join(dir, "security") })).rejects.toThrow(/outside the checkout/);
    await expect(session.writeTextFile({ path: join(dir, "gh"), content: "exit 0\n" })).rejects.toThrow(
      /outside the checkout/,
    );
    // Nor the agents' sign-ins, beside them in their HOME.
    await expect(session.readTextFile({ path: join(agents, ".claude/.credentials.json") })).rejects.toThrow(
      /outside the checkout/,
    );
    // The rest of the box's home is the session's.
    await session.writeTextFile({ path: join(home, ".pi/agent/settings.json"), content: "{}" });
  });

  it("answer security as an empty Keychain that takes nothing", async () => {
    // What Claude Code asks: no item to find or remove (macOS's 44), so it reads and writes its own file.
    for (const args of [
      ["find-generic-password", "-a", "ada", "-w", "-s", "Claude Code-credentials"],
      ["delete-generic-password", "-a", "ada", "-s", "Claude Code-credentials"],
      ["-q", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
    ]) {
      expect(run("security", args)).toMatchObject({ status: 44, stdout: "" });
    }
    // A lookup as a command on stdin is one too.
    expect(run("security", ["-i"], 'find-generic-password -a "ada" -s "Claude Code-credentials" -w\n')).toMatchObject({
      status: 44,
      stdout: "",
    });
    // Its save, as commands on stdin or as arguments: refused, its commands read first.
    const save = 'add-generic-password -U -a "ada" -s "Claude Code-credentials" -X "7b7d"\n';
    expect(run("security", ["-i"], save)).toMatchObject({ status: 1, stdout: "" });
    expect(run("security", ["add-generic-password", "-U", "-a", "ada", "-s", "x", "-X", "7b7d"]).status).toBe(1);
    // A writer that keeps stdin open for an answer still gets one.
    const open = spawn(join(dir, "security"), ["-i"]);
    open.stdin.write(save);
    expect(await new Promise((done) => open.on("exit", done))).toBe(1);
    open.stdin.destroy();
    // Nothing else of the Keychain: never this machine's.
    for (const args of [["dump-keychain"], ["find-internet-password", "-s", "github.com"], ["unlock-keychain"], []]) {
      expect(run("security", args)).toEqual({
        status: 1,
        stdout: "",
        stderr: "security is not available to a person's own agent in Sanoma\n",
      });
    }
  });
});

describe("a person's own agent's install", () => {
  it("lands in the agents' HOME in the box, installed by pnpm run there with that HOME", async () => {
    // A package of this machine's, so no registry: its bin says its HOME.
    const pkg = join(scratch, "fake-agent");
    mkdirSync(pkg);
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "fake-agent", version: "1.0.0", bin: { "fake-agent": "bin.js" } }),
    );
    writeFileSync(join(pkg, "bin.js"), '#!/usr/bin/env node\nprocess.stdout.write(process.env.HOME ?? "");\n');
    const at = join(agents, "fake");
    const agent = { title: "Fake", packages: [`file:${pkg}`], bin: "fake-agent", args: [], signIn: { run: [] } };
    await install(box, agent, at);
    expect(readFileSync(join(at, "installed.json"), "utf8")).toBe(JSON.stringify(agent.packages));
    // Its bin, and pnpm's store, as the box sees them with the agents' HOME: theirs, never this
    // machine user's, the store written by the install.
    const said = async (command: string) => {
      const ran = await box.run(command, { cwd: at, env: { HOME: agents } });
      const [out, { exitCode }] = await Promise.all([new Response(ran.stdout).text(), ran.wait()]);
      return { out: out.trim(), exitCode };
    };
    expect(await said("node_modules/.bin/fake-agent")).toEqual({ out: agents, exitCode: 0 });
    const store = (await said("pnpm store path")).out;
    expect(store.startsWith(`${agents}/`) && existsSync(store)).toBe(true);
    // Installed: the next turn finds it so.
    rmSync(join(at, "node_modules"), { recursive: true });
    await install(box, agent, at);
    expect(existsSync(join(at, "node_modules"))).toBe(false);
  }, 120_000);
});

/** Claude Code on a person's plan, as the Anthropic connector gives it. */
const claudeCode = ownAgent(resolveConfig({ workflows: [], connectors: [anthropic] }), "claude-code");

describe.runIf(process.env.SANOMA_LIVE === "1" && process.platform === "darwin")("Claude Code on macOS", () => {
  it("keeps what it stores in its own file under the person's home, through the shims", () => {
    const installed = join(scratch, "claude-code");
    const personal = join(scratch, "people/ada");
    mkdirSync(installed, { recursive: true });
    mkdirSync(personal, { recursive: true });
    execFileSync("pnpm", ["add", "--ignore-scripts", "--ignore-workspace", ...claudeCode.packages], {
      cwd: installed,
      stdio: "ignore",
    });
    const pnpm = join(installed, "node_modules/.pnpm");
    const platform = `claude-agent-sdk-darwin-${process.arch}`;
    const sdk = readdirSync(pnpm).find((name) => name.startsWith(`@anthropic-ai+${platform}@`));
    if (!sdk) throw new Error(`no @anthropic-ai/${platform} under ${pnpm}: the adapter's dependency moved`);
    const claude = join(pnpm, sdk, "node_modules/@anthropic-ai", platform, "claude");
    // A secret it keeps where it keeps its sign-in (the same store and the same save), with no
    // account: an MCP server's client secret.
    const said = execFileSync(
      claude,
      [
        "mcp",
        "add",
        "--transport",
        "http",
        "--client-id",
        "probe",
        "--client-secret",
        "probe",
        "http://127.0.0.1:9/mcp",
      ],
      {
        cwd: personal,
        encoding: "utf8",
        env: {
          HOME: personal,
          PATH: `${dir}:/usr/bin:/bin`,
          MCP_CLIENT_SECRET: "made-up",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
    );
    expect(said).not.toContain("could not be stored");
    const stored = JSON.parse(readFileSync(join(personal, ".claude/.credentials.json"), "utf8"));
    expect(Object.keys(stored)).toEqual(["mcpOAuthClientConfig"]);
  }, 600_000);
});
