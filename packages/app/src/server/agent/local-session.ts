import { spawn as spawnChild } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import {
  harnessSessionDataDirectoryPath,
  harnessStateDirectoryPath,
  type HarnessV1NetworkSandboxSession,
} from "@ai-sdk/harness";
import { allowedPath } from "./checkout.ts";

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
  /** The process groups its commands lead, killed by `stop` whether or not their leader has exited. */
  readonly #groups = new Set<number>();

  constructor({ id, root, home, port }: LocalSessionOptions) {
    this.id = id;
    this.defaultWorkingDirectory = resolve(root);
    this.#home = resolve(home);
    this.ports = [port];
    this.env = sessionEnv(this.#home);
  }

  /** `path` as the session may use it: the checkout's by the checkout rule, else under its home; refused otherwise. */
  async #path(path: string): Promise<string> {
    const full = resolve(this.defaultWorkingDirectory, path);
    const inHome = relative(this.#home, full);
    if (inHome === "" || (!inHome.startsWith(`..${sep}`) && inHome !== ".." && !isAbsolute(inHome))) return full;
    const allowed = await allowedPath(this.defaultWorkingDirectory, full);
    if (allowed === undefined) throw new Error(`${path} is outside the checkout, or under .git or node_modules`);
    return allowed;
  }

  readBinaryFile = async ({ path }: At) => {
    const full = await this.#path(path);
    return readFile(full).then(
      (bytes) => new Uint8Array(bytes),
      () => null,
    );
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
    return bytes && (Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>);
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
      child.on("close", (code) => done({ exitCode: code ?? 1 }));
    });
    const kill = async () => {
      if (group !== undefined) killGroup(group);
    };
    abortSignal?.addEventListener("abort", () => void kill(), { once: true });
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
    const state = harnessStateDirectoryPath({ sandboxHomeDir: this.#home });
    await rm(harnessSessionDataDirectoryPath({ stateDirectory: state, sessionId: this.id }), {
      recursive: true,
      force: true,
    });
  };

  restricted = () => this;
}

const web = (stream: Readable) => Readable.toWeb(stream) as ReadableStream<Uint8Array>;

/** Kills the process group `group` (a `detached` child's pid). */
function killGroup(group: number) {
  try {
    process.kill(-group, "SIGKILL");
  } catch {
    // Gone already.
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
