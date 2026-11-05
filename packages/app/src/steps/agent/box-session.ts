import { dirname, relative, resolve } from "node:path";
import {
  harnessSessionDataDirectoryPath,
  harnessStateDirectoryPath,
  type HarnessV1NetworkSandboxSession,
} from "@ai-sdk/harness";
import type { Box } from "@sanoma-ai/workflows";
import { allowedPath, realWithin, within } from "./checkout.ts";

// The sandbox session `HarnessAgent` runs a coding agent in, over a box of the `Sandbox` contract:
// its commands are the box's, in the draft's checkout; its files that checkout's and the box's
// home's; its bridge on a port the box exposes.

type Run = { command: string; workingDirectory?: string; env?: Record<string, string>; abortSignal?: AbortSignal };
type At = { path: string; abortSignal?: AbortSignal };

/** What a session is made of besides its box: its id, the draft's checkout it works in, the box's home, and the ports it leases. */
export interface BoxSessionOptions {
  /** The harness session's id (`createSession({ sessionId })`), whose `.agent-runs` it deletes when destroyed. */
  id: string;
  /** The draft's checkout (`Draft.root`): where the agent works, and the only files of the repository it may touch. */
  root: string;
  /**
   * The box's home (`homeOf`), kept across turns: a bridge installs its agent under it once
   * (`.ai-sdk-harness`). The session may read and write anything under it but another session's
   * run files. That holds for the session's own file calls (Pi's); a bridge reads, and runs what
   * it starts, as the box's user.
   */
  home: string;
  /** The ports its bridge listens on (`freePort`). */
  ports: readonly number[];
}

/** The box's home, `$HOME` as its commands see it. */
export async function homeOf(box: Box): Promise<string> {
  const said = await box.run('printf %s "$HOME"');
  const [home, { exitCode }] = await Promise.all([new Response(said.stdout).text(), said.wait()]);
  if (exitCode !== 0 || !home) throw new Error(`The box ${box.id} has no home`);
  return home;
}

/**
 * The session over `box`, `HarnessV1NetworkSandboxSession`. A path is the checkout's as the
 * checkout rule allows it (`allowedPath`), or under the box's home, or refused. `stop` stops the
 * box; `destroy` deletes the session's `.agent-runs`, which a bridge writes the model's key into,
 * and stops it; `HarnessAgentSession.destroy()` leaves a session it was given running.
 */
export const boxSession = (box: Box, options: BoxSessionOptions): HarnessV1NetworkSandboxSession =>
  new BoxSession(box, options);

class BoxSession implements HarnessV1NetworkSandboxSession {
  readonly description =
    "A coding agent's box: its commands in the draft's checkout, the bridge on a port the box exposes";
  readonly id: string;
  readonly defaultWorkingDirectory: string;
  readonly ports: ReadonlyArray<number>;
  readonly #box: Box;
  readonly #home: string;
  /** Its own run files (`.agent-runs/<id>`), which a bridge writes the model's key into. */
  readonly #runs: string;

  constructor(box: Box, { id, root, home, ports }: BoxSessionOptions) {
    this.#box = box;
    this.id = id;
    this.defaultWorkingDirectory = resolve(root);
    this.#home = resolve(home);
    const state = harnessStateDirectoryPath({ sandboxHomeDir: this.#home });
    this.#runs = harnessSessionDataDirectoryPath({ stateDirectory: state, sessionId: id });
    this.ports = [...ports];
  }

  /** `path` as the session may use it: the checkout's by the checkout rule, else under its home; refused otherwise. */
  async #path(path: string): Promise<string> {
    const full = resolve(this.defaultWorkingDirectory, path);
    // Its home, by real paths (a link there leads nowhere else), but no other session's run files
    // (a bridge's start config holds the key), in any case (macOS's file system ignores it).
    const home = within(this.#home, full) ? await realWithin(this.#home, full) : undefined;
    if (home !== undefined) {
      const inside = home.inside.toLowerCase();
      const runs = relative(this.#home, this.#runs).toLowerCase();
      if (!within(dirname(runs), inside) || within(runs, inside)) return home.full;
    }
    const allowed = await allowedPath(this.defaultWorkingDirectory, full);
    if (allowed === undefined) throw new Error(`${path} is outside the checkout, or under .git or node_modules`);
    return allowed;
  }

  readBinaryFile = async ({ path }: At) => this.#box.read(await this.#path(path));

  readTextFile = async ({ path, startLine, endLine }: At & { startLine?: number; endLine?: number }) => {
    const bytes = await this.readBinaryFile({ path });
    if (bytes === null) return null;
    const text = new TextDecoder().decode(bytes);
    if (startLine === undefined && endLine === undefined) return text;
    return text
      .split("\n")
      .slice((startLine ?? 1) - 1, endLine)
      .join("\n");
  };

  readFile = async (at: At) => {
    const bytes = await this.readBinaryFile(at);
    return bytes && new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();
  };

  writeBinaryFile = async ({ path, content }: At & { content: Uint8Array }) =>
    this.#box.write(await this.#path(path), content);

  writeTextFile = ({ path, content, abortSignal }: At & { content: string }) =>
    this.writeBinaryFile({ path, content: new TextEncoder().encode(content), abortSignal });

  writeFile = async ({ path, content, abortSignal }: At & { content: ReadableStream<Uint8Array> }) =>
    this.writeBinaryFile({ path, content: new Uint8Array(await new Response(content).arrayBuffer()), abortSignal });

  spawn = async ({ command, workingDirectory, env, abortSignal }: Run) => {
    const started = await this.#box.run(command, {
      cwd: resolve(this.defaultWorkingDirectory, workingDirectory ?? "."),
      ...(env && { env }),
      ...(abortSignal && { signal: abortSignal }),
    });
    return {
      stdout: started.stdout,
      stderr: started.stderr,
      wait: () => started.wait(),
      kill: async () => started.kill(),
    };
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

  /** Where the host reaches its bridge: the box's exposed port, as a websocket when asked. */
  getPortEndpoint = async ({ port, protocol = "http" }: { port: number; protocol?: "http" | "https" | "ws" }) => {
    const { url, headers } = await this.#box.expose(port);
    return { url: protocol === "ws" ? url.replace(/^http/, "ws") : url, ...(headers && { headers }) };
  };

  getPortUrl = async (options: { port: number; protocol?: "http" | "https" | "ws" }) =>
    (await this.getPortEndpoint(options)).url;

  /** Stops the box: every command, and what a bridge started too. */
  stop = () => this.#box.stop();

  /** Deletes its `.agent-runs` (the bridge's start files, the model's key in them), then stops the box. */
  destroy = async () => {
    const removed = await this.#box.run('rm -rf -- "$RUNS"', { env: { RUNS: this.#runs } });
    const { exitCode } = await removed.wait();
    await this.stop();
    if (exitCode !== 0) throw new Error(`The session's run files were not deleted (exit ${exitCode})`);
  };

  restricted = () => this;
}
