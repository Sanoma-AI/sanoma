import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWN_AGENTS, shims } from "../src/server/agent/acp.ts";

// The shims first on a person's own agent's PATH (`shims` in acp.ts), run as the agent runs them:
// `gh`, `open` and `xdg-open` refuse; `security` is a Keychain that is there, empty, and takes
// nothing, so Claude Code keeps its sign-in in its own file under the person's home. With
// SANOMA_LIVE=1 on macOS, Claude Code itself, installed, stores a secret through them.

const scratch = mkdtempSync(join(tmpdir(), "sanoma-shims-"));
let dir = "";

beforeAll(async () => {
  dir = await shims(join(scratch, "acp"));
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Runs the shim `name` with `args` (and `input` on its stdin): its exit and what it printed. */
const run = (name: string, args: string[], input?: string) => {
  const { status, stdout, stderr } = spawnSync(join(dir, name), args, { input, encoding: "utf8", timeout: 5_000 });
  return { status, stdout, stderr };
};

describe("a person's own agent's shims", () => {
  it("are acp/shims, and refuse gh, open and xdg-open", () => {
    expect(dir).toBe(join(scratch, "acp/shims"));
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

describe.runIf(process.env.SANOMA_LIVE === "1" && process.platform === "darwin")("Claude Code on macOS", () => {
  it("keeps what it stores in its own file under the person's home, through the shims", () => {
    const install = join(scratch, "claude-code");
    const home = join(scratch, "people/ada");
    mkdirSync(install, { recursive: true });
    mkdirSync(home, { recursive: true });
    execFileSync("pnpm", ["add", "--ignore-scripts", "--ignore-workspace", ...OWN_AGENTS["claude-code"].packages], {
      cwd: install,
      stdio: "ignore",
    });
    const pnpm = join(install, "node_modules/.pnpm");
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
        cwd: home,
        encoding: "utf8",
        env: {
          HOME: home,
          PATH: `${dir}:/usr/bin:/bin`,
          MCP_CLIENT_SECRET: "made-up",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
    );
    expect(said).not.toContain("could not be stored");
    const stored = JSON.parse(readFileSync(join(home, ".claude/.credentials.json"), "utf8"));
    expect(Object.keys(stored)).toEqual(["mcpOAuthClientConfig"]);
  }, 600_000);
});
