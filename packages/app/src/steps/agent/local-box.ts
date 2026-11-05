import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { localBackend as localSandbox, type SandboxBackend } from "@sanoma-ai/workflows";

// The coding agents' boxes on this machine: the local backend of the `Sandbox` contract with their
// environment, and the ports a bridge in one listens on.

/**
 * A box's environment, the whole of it (never this process's): `PATH` (this Node first, then
 * this process's `PATH`, where pnpm 11 and bash must be), its `HOME`, a UTF-8 locale, and, for a
 * machine whose pnpm comes from corepack, corepack's home kept as this process's, so that pnpm is
 * the one this machine already uses, not a download into the box's home. A command adds its
 * own; the model's key reaches the agent through the adapter's `auth`, not from here.
 */
export const sessionEnv = (home: string): Record<string, string> => ({
  PATH: [dirname(process.execPath), process.env.PATH || "/usr/bin:/bin"].join(":"),
  HOME: home,
  LANG: "C.UTF-8",
  COREPACK_HOME: process.env.COREPACK_HOME || join(homedir(), ".cache", "node", "corepack"),
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
});

/**
 * The local backend's boxes under `dir` (`agentHome(step, "boxes")`), their commands in
 * `sessionEnv` of the box's home.
 */
export const localBackend = (dir: string): SandboxBackend => localSandbox(dir, sessionEnv);

/** A port free on loopback now, for a harness session's bridge. */
export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}
