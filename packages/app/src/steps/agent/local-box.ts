import { spawn as spawnChild } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import type { Box, Process, SandboxBackend, SandboxCapabilities } from "@sanoma-ai/workflows";

// The local backend of the `Sandbox` contract: boxes on this machine. A box is a directory, its
// home, kept across turns; its commands are child processes, each in a process group of its own;
// its ports are on loopback. No vendor account, nothing reached from outside.

/** What the local backend can do: its boxes are this machine's directories, which `stop` leaves. */
export const LOCAL_SANDBOX: SandboxCapabilities = { snapshot: true, pause: false, port: true };

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
 * The boxes under `dir` (`agentHome(step, "boxes")`): the box `name` is the directory
 * `<dir>/<name>`, its home, made on its first `open`, deleted by `discard`. This machine is its
 * image and its size, so it takes neither.
 */
export const localBackend = (dir: string): SandboxBackend => ({
  async open({ name }) {
    const home = boxDir(dir, name);
    await mkdir(home, { recursive: true });
    return localBox(name, home);
  },
  discard: ({ name }) => rm(boxDir(dir, name), { recursive: true, force: true }),
});

function boxDir(dir: string, name: string): string {
  if (!name || name !== basename(name) || name.startsWith(".")) throw new Error(`${name} is no box's name`);
  return join(dir, name);
}

/**
 * The box at `home`, over `node:child_process` and `node:fs`: a command is `bash -c` in a process
 * group of its own (killed whole by `kill`, and by `stop`), with `sessionEnv(home)` under the
 * caller's `env`; a relative path or `cwd` is under `home`, any other this machine's.
 */
function localBox(id: string, home: string): Box {
  /** The process groups its commands lead, killed by `stop` whether or not their leader has exited. */
  const groups = new Set<number>();
  const at = (path: string) => resolve(home, path);
  return {
    id,
    async run(command, { cwd, env, stdin, signal } = {}): Promise<Process> {
      const child = spawnChild("bash", ["-c", command], {
        cwd: at(cwd ?? "."),
        env: { ...sessionEnv(home), ...env },
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
    read: async (path) => {
      const bytes = await readFile(at(path)).catch(() => null);
      return bytes && new Uint8Array(bytes);
    },
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
function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kills the process group `group` (a `detached` child's pid). */
function killGroup(group: number, signal: NodeJS.Signals = "SIGKILL") {
  try {
    process.kill(-group, signal);
  } catch {
    // Gone already.
  }
}

/** How a `Command` ended: its exit code, or the signal that killed it. */
export interface Exit {
  exitCode: number | null;
  signal: string | null;
}

/** The most of a command's output a `Command` keeps when it is given no limit, in bytes. */
const OUTPUT_KEPT = 1 << 20;
/** How long a command's last output may take to arrive after it exits, in ms. */
const PIPES_WAIT = 200;

/**
 * A command run on this machine in a process group of its own (killed whole by `kill`), with the
 * environment it is given and nothing of this process's: what it prints kept (the last `limit`
 * bytes, from a character's start), or, as a `protocol`, its stdout and stdin left to the caller
 * and only its stderr kept. An ACP agent, a terminal it asks for, a vendor's sign-in, an install.
 */
export class Command {
  /** Its stdin and stdout as web streams, for a `protocol`: its stdout ends once it has exited. */
  readonly stdin?: WritableStream<Uint8Array>;
  readonly stdout?: ReadableStream<Uint8Array>;
  readonly exited: Promise<Exit>;
  /** How it ended, once it has. */
  status?: Exit;
  /** The most of its output kept, in bytes. */
  readonly limit: number;
  /** Called whenever it prints. */
  onOutput?: () => void;
  readonly #write?: Writable;
  readonly #group?: number;
  readonly #chunks: Buffer[] = [];
  #kept = 0;
  #dropped = false;
  #text?: string;

  constructor(
    command: string,
    args: readonly string[],
    {
      cwd,
      env,
      stdin,
      protocol,
      limit,
    }: { cwd: string; env: Record<string, string>; stdin?: boolean; protocol?: boolean; limit?: number },
  ) {
    this.limit = limit ?? OUTPUT_KEPT;
    const child = spawnChild(command, args, {
      cwd,
      env,
      stdio: [stdin || protocol ? "pipe" : "ignore", "pipe", "pipe"],
      detached: true,
    });
    this.#group = child.pid;
    child.stdin?.on("error", () => {});
    child.stderr!.on("data", this.#print);
    this.exited = new Promise((done) => {
      child.on("error", (err) => {
        this.#print(Buffer.from(`${err.message}\n`));
        done((this.status = { exitCode: 127, signal: null }));
      });
      // Exited when it exits, not when its pipes close: something it left running may hold them.
      // What it printed last still arrives, so the end waits a moment for that.
      child.on("exit", (exitCode, signal) => {
        this.status ??= { exitCode, signal };
        const end = () => done(this.status!);
        child.on("close", end);
        setTimeout(end, PIPES_WAIT).unref();
      });
    });
    if (protocol) {
      this.stdin = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
      // Its end waits for its exit, so whoever reads it sees how it ended first.
      this.stdout = web(child.stdout!).pipeThrough(
        new TransformStream({ flush: () => this.exited.then(() => undefined) }),
      );
    } else {
      this.#write = child.stdin ?? undefined;
      child.stdout!.on("data", this.#print);
    }
  }

  #print = (chunk: Buffer) => {
    this.#chunks.push(chunk);
    this.#kept += chunk.length;
    this.#text = undefined;
    // Whole chunks past the limit go now; `output` cuts the rest to it.
    while (this.#chunks.length > 1 && this.#kept - this.#chunks[0]!.length >= this.limit) {
      this.#kept -= this.#chunks.shift()!.length;
      this.#dropped = true;
    }
    this.onOutput?.();
  };

  /** Whether output was dropped to keep within `limit`. */
  get truncated() {
    return this.#dropped || this.#kept > this.limit;
  }

  /** What it printed and was kept, as text. */
  output = () => {
    if (this.#text !== undefined) return this.#text;
    const kept = Buffer.concat(this.#chunks);
    let start = Math.max(0, kept.length - this.limit);
    // Not from the middle of a character: past its continuation bytes.
    while (start < kept.length && start > 0 && (kept[start]! & 0xc0) === 0x80) start++;
    return (this.#text = kept.subarray(start).toString("utf8"));
  };

  /** Writes `text` to its stdin, when it was given one. */
  write(text: string) {
    this.#write?.write(text);
  }

  /** Kills its process group: what it started too. Once it has exited, only while that group is left, so a reused pid is never hit. */
  kill() {
    if (this.#group === undefined) return;
    if (this.status === undefined || groupAlive(this.#group)) killGroup(this.#group);
  }

  /** Resolves when it exits 0; an error with the end of what it printed otherwise. */
  async done(): Promise<void> {
    const exit = await this.exited;
    if (exit.exitCode === 0) return;
    const said = this.output().trim().split("\n").slice(-5).join("\n");
    throw new Error(`${exitText(exit)}${said ? `: ${said}` : ""}`);
  }
}

/** How a command ended, as a reply says it: the signal that killed it, or its exit code. */
export const exitText = ({ exitCode, signal }: Exit) => signal ?? `exit code ${exitCode}`;

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
