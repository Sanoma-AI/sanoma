import { dirname, relative, resolve } from "node:path";
import {
  harnessSessionDataDirectoryPath,
  harnessStateDirectoryPath,
  type HarnessV1NetworkSandboxSession,
} from "@ai-sdk/harness";
import { type AppStepContext, type Box, type Process, valueAt } from "sanoma/workflows";
import { NO_BOX } from "../../lib/chat.ts";
import { placeOf } from "../../loopback.ts";
import { secretValues } from "../../server/secrets.ts";
import { agentHome, boxName, inCheckout, type RealPaths, realIn, under, within } from "./checkout.ts";
import { localBackend } from "./local-box.ts";

// The sandbox session `HarnessAgent` runs a coding agent in, over a box of the `Sandbox` contract:
// its commands are the box's, in the draft's checkout; its files that checkout's and the box's
// home's; its bridge on a port the box exposes.

type Run = { command: string; workingDirectory?: string; env?: Record<string, string>; abortSignal?: AbortSignal };
type At = { path: string; abortSignal?: AbortSignal };

/** What a session is made of besides its box: its id, the draft's checkout it works in, the box's home, and the ports it leases. */
export interface BoxSessionOptions {
  /** The harness session's id (`createSession({ sessionId })`), whose `.agent-runs` it deletes when destroyed. */
  id: string;
  /** The draft's checkout in the box (`carryIn`'s clone): where the agent works, and the only files of the repository it may touch. */
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

/** The directory under a box's home that is a person's own agents' HOME (`acp.ts`): their installs, shims and sign-ins. */
export const OWN_AGENTS_DIR = ".acp";

/**
 * The box of the person `step` is run by, for the company (`boxName`), chosen: where every coding
 * agent of theirs works, `open` opening it for a turn, whose engine stops it when the turn ends.
 * The declared sandbox's (`sandboxes()`), through its connector's backend given its fields, with
 * the image and size it declares; else, on this computer (`placeOf`), the local backend's; on a
 * live instance, none: refused with `NO_BOX`, so that no agent runs inside the live instance.
 */
export async function personBox(
  step: Pick<AppStepContext, "source" | "resolved" | "by" | "client">,
): Promise<{ name: string; open: () => Promise<Box> }> {
  const { resolved, client } = step;
  const name = boxName(resolved.appName, step.by.id);
  const [declared] = await resolved.sandboxes();
  if (declared) {
    const make = resolved.sandboxBackends.get(declared.vendor);
    const { inputs } = resolved.types.get(`${declared.vendor}.${declared.type}`)!.sandbox!;
    if (!make) throw new Error(`${declared.id}: the ${declared.vendor} connector attaches no sandbox backend`);
    const [image, size] = [valueAt(declared.desired, inputs.image), valueAt(declared.desired, inputs.size)];
    return {
      name,
      open: async () =>
        (await make({ secrets: secretValues(client), declared: declared.desired })).open({
          name,
          // What it leaves out is the backend's own.
          ...(typeof image === "string" && { image }),
          ...(typeof size === "number" && { size }),
        }),
    };
  }
  if (placeOf(resolved.databaseUrl) === "live") throw new Error(NO_BOX);
  // This machine is the local box's image and size.
  return { name, open: () => localBackend(agentHome(step, "boxes")).open({ name }) };
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
 * checkout rule allows it (`allowedPaths`, on the box's files), or under the box's home, or refused. `stop` stops the
 * box; `destroy` kills what the session started (so the box stays up for the turn's carry back,
 * and its opener stops it) and deletes the session's `.agent-runs`, which a bridge writes the
 * model's key into; `HarnessAgentSession.destroy()` leaves a session it was given running.
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
  /** What it started, killed when it is destroyed. */
  readonly #started = new Set<Process>();
  /** Real paths in the box, where its files are. */
  readonly #real: RealPaths;

  constructor(box: Box, { id, root, home, ports }: BoxSessionOptions) {
    this.#box = box;
    this.#real = realIn(box);
    this.id = id;
    this.defaultWorkingDirectory = resolve(root);
    this.#home = resolve(home);
    const state = harnessStateDirectoryPath({ sandboxHomeDir: this.#home });
    this.#runs = harnessSessionDataDirectoryPath({ stateDirectory: state, sessionId: id });
    this.ports = [...ports];
  }

  /**
   * `path` as the session may use it, by its real path in the box: the checkout's by the checkout
   * rule, else under its home; refused otherwise.
   */
  async #path(path: string): Promise<string> {
    const full = resolve(this.defaultWorkingDirectory, path);
    const [home, root, real] = await this.#real([this.#home, this.defaultWorkingDirectory, full]);
    // Its home, by real paths (a link there leads nowhere else), but no other session's run files
    // (a bridge's start config holds the key) and nothing of the person's own agents (`OWN_AGENTS_DIR`:
    // their sign-ins, and what they run), in any case (macOS's file system ignores it), and not the
    // checkout when the home holds it (the box's clone), nor a link there into it: those are the
    // checkout rule's.
    const homeOnly = within(this.#home, full) && !within(this.defaultWorkingDirectory, full);
    if (homeOnly && real && home && under(home, real) && !under(root, real)) {
      const inside = relative(home, real).toLowerCase();
      const runs = relative(this.#home, this.#runs).toLowerCase();
      const own = within(OWN_AGENTS_DIR, inside);
      if (!own && (!within(dirname(runs), inside) || within(runs, inside))) return real;
    }
    const allowed = inCheckout(root, real);
    if (allowed === undefined) throw new Error(`${path} is outside the checkout, or under .git or node_modules`);
    return allowed;
  }

  readBinaryFile = async ({ path }: At) => this.#box.read(await this.#path(path));

  readTextFile = async ({ path, startLine, endLine }: At & { startLine?: number; endLine?: number }) => {
    const bytes = await this.readBinaryFile({ path });
    if (bytes === null) return null;
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
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
    this.#started.add(started);
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

  /** Kills what it started and waits for it to exit, so no bridge writes again, then deletes its `.agent-runs` (the bridge's start files, the model's key in them). */
  destroy = async () => {
    const started = [...this.#started];
    this.#started.clear();
    await Promise.all(
      started.map((command) => {
        command.kill("SIGKILL");
        return command.wait();
      }),
    );
    const removed = await this.#box.run('rm -rf -- "$RUNS"', { env: { RUNS: this.#runs } });
    const { exitCode } = await removed.wait();
    if (exitCode !== 0) throw new Error(`The session's run files were not deleted (exit ${exitCode})`);
  };

  restricted = () => this;
}
