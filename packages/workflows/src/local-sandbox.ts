import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import type { Box, Process, SandboxBackend, SandboxCapabilities } from "./sandbox-contract.ts";

// The local backend of the `Sandbox` contract: boxes on this machine, the app's for a coding agent
// on a laptop and the testing package's fake. A box is a directory, its home, kept across stops;
// its commands are child processes, each in a process group of its own; its ports are loopback's.

/** What the local backend can do: its boxes are this machine's directories, which `stop` leaves. */
export const LOCAL_SANDBOX: SandboxCapabilities = { snapshot: true, pause: false, port: true };

/**
 * The boxes under `dir`: the box `name` is the directory `<dir>/<name>`, its home, made on its
 * first `open`, deleted by `discard`. This machine is its image and its size, so it takes neither.
 * A command's environment is `env(home)` (default: this Node and this process's `PATH`, and
 * `HOME`), never this process's, under the caller's `env`.
 */
export const localBackend = (
  dir: string,
  env: (home: string) => Record<string, string> = (home) => ({
    PATH: [dirname(process.execPath), process.env.PATH || "/usr/bin:/bin"].join(":"),
    HOME: home,
  }),
): SandboxBackend => ({
  async open({ name }) {
    const home = boxDir(dir, name);
    await mkdir(home, { recursive: true });
    return localBox(name, home, env(home));
  },
  discard: ({ name }) => rm(boxDir(dir, name), { recursive: true, force: true }),
});

function boxDir(dir: string, name: string): string {
  if (!name || name !== basename(name) || name.startsWith(".")) throw new Error(`${name} is no box's name`);
  return join(dir, name);
}

/**
 * The box at `home`, over `node:child_process` and `node:fs`: a command is `bash -c` in a process
 * group of its own (killed whole by `kill`, and by `stop`), with `base` under the caller's `env`;
 * a relative path or `cwd` is under `home`, any other this machine's.
 */
function localBox(id: string, home: string, base: Record<string, string>): Box {
  /** The process groups its commands lead, killed by `stop` whether or not their leader has exited. */
  const groups = new Set<number>();
  const at = (path: string) => resolve(home, path);
  return {
    id,
    async run(command, { cwd, env, stdin, signal } = {}): Promise<Process> {
      const child = spawn("bash", ["-c", command], {
        cwd: at(cwd ?? "."),
        env: { ...base, ...env },
        stdio: "pipe",
        // Its own process group, so a bridge and what it starts are killed together.
        detached: true,
      });
      const group = child.pid;
      if (group !== undefined) groups.add(group);
      child.stdin.on("error", () => {});
      if (!stdin) child.stdin.end();
      const exited = new Promise<{ exitCode: number }>((done) => {
        child.on("error", () => done({ exitCode: 127 }));
        child.on("close", (code) => {
          // Forgotten once none of its group is left, so `stop` kills no group its pid leads later.
          if (group !== undefined && !groupAlive(group)) groups.delete(group);
          done({ exitCode: code ?? 1 });
        });
      });
      const kill = (sig: NodeJS.Signals = "SIGKILL") => {
        if (group !== undefined) killGroup(group, sig);
      };
      const onAbort = () => kill();
      if (signal?.aborted) onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      void exited.then(() => signal?.removeEventListener("abort", onAbort));
      return {
        stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        stdout: web(child.stdout),
        stderr: web(child.stderr),
        wait: () => exited,
        kill,
      };
    },
    // A Buffer is a Uint8Array: no copy.
    read: (path) => readFile(at(path)).catch(() => null),
    async write(path, bytes, { mode } = {}) {
      await mkdir(dirname(at(path)), { recursive: true });
      await writeFile(at(path), bytes);
      if (mode !== undefined) await chmod(at(path), mode);
    },
    /** A port on loopback. */
    expose: async (port) => ({ url: `http://127.0.0.1:${port}` }),
    /** Kills every command's process group: what a bridge started too. */
    async stop() {
      for (const group of groups) killGroup(group);
      groups.clear();
    },
  };
}

const web = (stream: Readable) => Readable.toWeb(stream) as ReadableStream<Uint8Array>;

/** Whether any process of the group `group` is left. */
export function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kills the process group `group` (a `detached` child's pid). */
export function killGroup(group: number, signal: NodeJS.Signals = "SIGKILL") {
  try {
    process.kill(-group, signal);
  } catch {
    // Gone already.
  }
}
