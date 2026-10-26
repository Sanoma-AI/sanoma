import { spawn as spawnChild } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  harnessSessionDataDirectoryPath,
  harnessStateDirectoryPath,
  type HarnessV1NetworkSandboxSession,
} from "@ai-sdk/harness";
import { allowedPath, within } from "./checkout.ts";

// The sandbox session `HarnessAgent` runs a coding agent in, on this machine: its commands are
// child processes in the draft's checkout, its files that checkout's and its own home's, its bridge
// a port on loopback. No vendor account, nothing reached from outside but the bridge's port.

type Run = { command: string; workingDirectory?: string; env?: Record<string, string>; abortSignal?: AbortSignal };
type At = { path: string; abortSignal?: AbortSignal };

/** What a session is made of: its id, the draft's checkout it works in, its home, and the port it leases. */
export interface LocalSessionOptions {
  /** The harness session's id (`createSession({ sessionId })`), whose `.agent-runs` it deletes when destroyed. */
  id: string;
  /** The draft's checkout (`Draft.root`): where the agent works, and the only files of the repository it may touch. */
  root: string;
  /** Its `HOME`, kept across restarts: a bridge installs its agent under it once (`.ai-sdk-harness`). */
  home: string;
  /** The loopback port its bridge listens on (`freePort`). */
  port: number;
}

/**
 * The session's environment, the whole of it (never this process's): `PATH` (this Node first, then
 * this process's `PATH`, where pnpm 11 and bash must be), its `HOME`, a UTF-8 locale, and
 * corepack's home kept as this process's, so the session's pnpm is the one this machine already
 * uses (its last known good, pnpm 11), not a download into the session's home. A command adds its
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
 * A local session, `HarnessV1NetworkSandboxSession` over `node:child_process` and `node:fs`.
 * Commands run in bash, each in a process group of its own (killed whole by `destroy`). A path is
 * the checkout's as the checkout rule allows it (`allowedPath`), or under the session's home, or
 * refused. `destroy` kills what is left and deletes the session's `.agent-runs`, which a bridge
 * writes the model's key into; `HarnessAgentSession.destroy()` leaves a session it was given running.
 */
export class LocalSession implements HarnessV1NetworkSandboxSession {
  readonly description =
    "A local session: child processes on this machine, in the draft's checkout; the bridge on loopback";
  readonly id: string;
  readonly defaultWorkingDirectory: string;
  readonly ports: ReadonlyArray<number>;
  readonly env: Readonly<Record<string, string>>;
  readonly #home: string;
  /** Its own run files (`.agent-runs/<id>`), which a bridge writes the model's key into. */
  readonly #runs: string;
  /** The process groups its commands lead, killed by `stop` whether or not their leader has exited. */
  readonly #groups = new Set<number>();

  constructor({ id, root, home, port }: LocalSessionOptions) {
    this.id = id;
    this.defaultWorkingDirectory = resolve(root);
    this.#home = resolve(home);
    const state = harnessStateDirectoryPath({ sandboxHomeDir: this.#home });
    this.#runs = harnessSessionDataDirectoryPath({ stateDirectory: state, sessionId: id });
    this.ports = [port];
    this.env = sessionEnv(this.#home);
  }

  /** `path` as the session may use it: the checkout's by the checkout rule, else under its home; refused otherwise. */
  async #path(path: string): Promise<string> {
    const full = resolve(this.defaultWorkingDirectory, path);
    // Its home, but no other session's run files (a bridge's start config holds the key).
    if (within(this.#home, full) && (!within(dirname(this.#runs), full) || within(this.#runs, full))) return full;
    const allowed = await allowedPath(this.defaultWorkingDirectory, full);
    if (allowed === undefined) throw new Error(`${path} is outside the checkout, or under .git or node_modules`);
    return allowed;
  }

  readBinaryFile = async ({ path }: At) => {
    const bytes = await readFile(await this.#path(path)).catch(() => null);
    return bytes && new Uint8Array(bytes);
  };

  readTextFile = async ({ path, startLine, endLine }: At & { startLine?: number; endLine?: number }) => {
    const text = await readFile(await this.#path(path), "utf8").catch(() => null);
    if (text === null || (startLine === undefined && endLine === undefined)) return text;
    return text
      .split("\n")
      .slice((startLine ?? 1) - 1, endLine)
      .join("\n");
  };

  readFile = async (at: At) => {
    const bytes = await this.readBinaryFile(at);
    return bytes && new Blob([bytes]).stream();
  };

  writeBinaryFile = async ({ path, content }: At & { content: Uint8Array }) => {
    const full = await this.#path(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  };

  writeTextFile = ({ path, content, abortSignal }: At & { content: string }) =>
    this.writeBinaryFile({ path, content: new TextEncoder().encode(content), abortSignal });

  writeFile = async ({ path, content, abortSignal }: At & { content: ReadableStream<Uint8Array> }) =>
    this.writeBinaryFile({ path, content: new Uint8Array(await new Response(content).arrayBuffer()), abortSignal });

  spawn = async ({ command, workingDirectory, env, abortSignal }: Run) => {
    const child = spawnChild("bash", ["-c", command], {
      cwd: resolve(this.defaultWorkingDirectory, workingDirectory ?? "."),
      env: { ...this.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a bridge and what it starts are killed together.
      detached: true,
    });
    const group = child.pid;
    if (group !== undefined) this.#groups.add(group);
    const exited = new Promise<{ exitCode: number }>((done) => {
      child.on("error", () => done({ exitCode: 127 }));
      child.on("close", (code) => {
        // Forgotten once none of its group is left, so `stop` kills no group its pid leads later.
        if (group !== undefined && !groupAlive(group)) this.#groups.delete(group);
        done({ exitCode: code ?? 1 });
      });
    });
    const kill = async () => {
      if (group !== undefined) killGroup(group);
    };
    const onAbort = () => void kill();
    if (abortSignal?.aborted) onAbort();
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    void exited.then(() => abortSignal?.removeEventListener("abort", onAbort));
    return { pid: child.pid, stdout: web(child.stdout!), stderr: web(child.stderr!), wait: () => exited, kill };
  };

  run = async (options: Run) => {
    const ran = await this.spawn(options);
    const [stdout, stderr, { exitCode }] = await Promise.all([
      new Response(ran.stdout).text(),
      new Response(ran.stderr).text(),
      ran.wait(),
    ]);
    return { exitCode, stdout, stderr };
  };

  /** A port on loopback, where the host reaches its bridge. */
  getPortEndpoint = async ({ port, protocol = "http" }: { port: number; protocol?: "http" | "https" | "ws" }) => ({
    url: `${protocol}://127.0.0.1:${port}`,
  });

  getPortUrl = async (options: { port: number; protocol?: "http" | "https" | "ws" }) =>
    (await this.getPortEndpoint(options)).url;

  /** Kills every command's process group: what a bridge started too. */
  stop = async () => {
    for (const group of this.#groups) killGroup(group);
    this.#groups.clear();
  };

  /** Stops it and deletes its `.agent-runs` (the bridge's start files, the model's key in them). */
  destroy = async () => {
    await this.stop();
    await rm(this.#runs, { recursive: true, force: true });
  };

  restricted = () => this;
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
function killGroup(group: number) {
  try {
    process.kill(-group, "SIGKILL");
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

/**
 * A command run on this machine in a process group of its own (killed whole by `kill`), with the
 * environment it is given and nothing of this process's: what it prints kept (the last `limit`
 * bytes, from a character's start), or, as a `protocol`, its stdout and stdin left to the caller
 * and only its stderr kept. An ACP agent, a terminal it asks for, a vendor's sign-in, an install.
 */
export class Command {
  /** Its stdin and stdout as web streams, for a `protocol`. */
  readonly stdin?: WritableStream<Uint8Array>;
  readonly stdout?: ReadableStream<Uint8Array>;
  readonly exited: Promise<Exit>;
  /** How it ended, once it has. */
  status?: Exit;
  /** The most of its output kept, in bytes. */
  limit?: number;
  /** Whether output was dropped to keep within `limit`. */
  truncated = false;
  /** Called whenever it prints. */
  onOutput?: () => void;
  readonly #write?: Writable;
  readonly #group?: number;
  #output = Buffer.alloc(0);

  constructor(
    command: string,
    args: readonly string[],
    { cwd, env, stdin, protocol }: { cwd: string; env: Record<string, string>; stdin?: boolean; protocol?: boolean },
  ) {
    const child = spawnChild(command, args, {
      cwd,
      env,
      stdio: [stdin || protocol ? "pipe" : "ignore", "pipe", "pipe"],
      detached: true,
    });
    this.#group = child.pid;
    if (protocol) {
      this.stdin = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
      this.stdout = web(child.stdout!);
    } else {
      this.#write = child.stdin ?? undefined;
      child.stdout!.on("data", this.#print);
    }
    child.stdin?.on("error", () => {});
    child.stderr!.on("data", this.#print);
    this.exited = new Promise((done) => {
      child.on("error", (err) => {
        this.#print(Buffer.from(`${err.message}\n`));
        done((this.status = { exitCode: 127, signal: null }));
      });
      child.on("close", (exitCode, signal) => done((this.status ??= { exitCode, signal })));
    });
  }

  #print = (chunk: Buffer) => {
    const kept = Buffer.concat([this.#output, chunk]);
    const limit = this.limit ?? OUTPUT_KEPT;
    let start = Math.max(0, kept.length - limit);
    // Not from the middle of a character: past its continuation bytes.
    while (start < kept.length && start > 0 && (kept[start]! & 0xc0) === 0x80) start++;
    if (start > 0) this.truncated = true;
    this.#output = kept.subarray(start);
    this.onOutput?.();
  };

  /** What it printed and was kept, as text. */
  output = () => this.#output.toString("utf8");

  /** Writes `text` to its stdin, when it was given one. */
  write(text: string) {
    this.#write?.write(text);
  }

  /** Kills its process group: what it started too. */
  kill() {
    if (this.#group !== undefined) killGroup(this.#group);
  }

  /** Resolves when it exits 0; an error with the end of what it printed otherwise. */
  async done(): Promise<void> {
    const { exitCode, signal } = await this.exited;
    if (exitCode === 0) return;
    const said = this.output().trim().split("\n").slice(-5).join("\n");
    throw new Error(`${signal ?? `exit code ${exitCode}`}${said ? `: ${said}` : ""}`);
  }
}

/** A port free on loopback now, for a session's bridge. */
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
