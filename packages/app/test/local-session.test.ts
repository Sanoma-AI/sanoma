import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "@sanoma-ai/testing";
import { afterAll, describe, expect, it } from "vitest";
import { freePort, LocalSession } from "../src/server/agent/local-session.ts";

// The local session `HarnessAgent` runs a coding agent in: its members on their own, no agent.

const base = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-session-")));
const root = join(base, "draft");
const home = join(base, "home");
mkdirSync(join(root, "workflows"), { recursive: true });
mkdirSync(join(root, ".git"));
mkdirSync(join(root, "node_modules"));
mkdirSync(home);
execFileSync("ln", ["-s", tmpdir(), join(root, "out")]);

const session = (id = "s1") => new LocalSession({ id, root, home, port: 4321 });

afterAll(() => rmSync(base, { recursive: true, force: true }));

/** Whether a process `pid` is alive. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("LocalSession", () => {
  it("runs commands in bash, in the checkout, with its own environment and none of this process's", async () => {
    process.env.SANOMA_SESSION_SECRET = "from this process";
    try {
      const ran = await session().run({ command: "set -o pipefail; pwd; env", env: { WORK_DIR: "x" } });
      expect(ran.exitCode).toBe(0);
      const [cwd, ...env] = ran.stdout.trim().split("\n");
      expect(cwd).toBe(root);
      const names = env
        .map((line) => line.split("=")[0])
        .filter((name) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(name!));
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
    const local = new LocalSession({ id: "p", root, home, port });
    expect(local.ports).toEqual([port]);
    expect(await local.getPortEndpoint({ port, protocol: "ws" })).toEqual({ url: `ws://127.0.0.1:${port}` });
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
    for (const path of ["../outside.txt", "/etc/passwd", "out/x", ".git/config", "node_modules/x/index.js"]) {
      await expect(local.writeTextFile({ path, content: "no" }), path).rejects.toThrow(/outside the checkout/);
      await expect(local.readBinaryFile({ path }), path).rejects.toThrow(/outside the checkout/);
    }
    expect(existsSync(join(base, "outside.txt"))).toBe(false);
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
