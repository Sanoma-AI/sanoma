import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { type WebSocket, WebSocketServer } from "ws";
import { localBox } from "./local-sandbox.ts";
import {
  FILE,
  frame,
  RUNNER_PORT,
  type RunnerAnswer,
  type RunnerRequest,
  STDERR,
  STDIN,
  STDOUT,
  unframe,
} from "./runner-protocol.ts";
import type { Process } from "./sandbox-contract.ts";

// The runner: the server of ours a backend starts inside a remote box, which `runnerBox` talks to
// over a WebSocket (the protocol is in `runner-protocol.ts`). It serves this machine as the local
// backend's box does (`localBox`, whose code it bundles): commands are `bash -c` in process groups
// of their own, a relative path or `cwd` is under the home. Built into one file,
// `dist/sandbox-runner.cjs` (`ws` bundled in), run as `node sandbox-runner.cjs`.
//
// It listens on `SANOMA_RUNNER_HOST:SANOMA_RUNNER_PORT` (default `0.0.0.0:7700`) and asks no
// credential: the vendor's edge authenticates every request to the port, the upgrade too
// (Agent37: the API key, on a port never made public). Anything inside the box already runs as
// the box's user, so a secret of the runner's own would guard nothing.

const port = Number(process.env.SANOMA_RUNNER_PORT ?? RUNNER_PORT);
const host = process.env.SANOMA_RUNNER_HOST ?? "0.0.0.0";

/** How long an exited command's last output may take to be sent before its exit, in ms. */
const LAST_OUTPUT = 200;
/** How often a connection is pinged: Agent37's edge closes one silent for 15 minutes. */
const BEAT = 30_000;

const box = localBox("runner", homedir(), process.env as Record<string, string>);

const server = createServer((req, res) => void res.writeHead(req.url === "/health" ? 200 : 404).end());
new WebSocketServer({ server }).on("connection", serve);
server.listen(port, host, () => {
  const { address, port: bound } = server.address() as AddressInfo;
  console.log(`sanoma runner listening on ${address}:${bound}`);
});
// Asked to end (the box shuts down): what it started ends with it.
process.on("SIGTERM", () => void box.stop().finally(() => process.exit(0)));

/** One client's connection: its commands, by the ids it gave them. */
function serve(ws: WebSocket) {
  // Promises: a command's kill and its stdin may come before it has started, and wait for it.
  const processes = new Map<number, Promise<Process>>();
  const inputs = new Map<number, Promise<WritableStreamDefaultWriter<Uint8Array>>>();
  /** The writes whose bytes are yet to come. */
  const writes = new Map<number, { path: string; mode?: number }>();
  const send = (data: Uint8Array | string) => ws.readyState === ws.OPEN && ws.send(data);
  const say = (answer: RunnerAnswer) => send(JSON.stringify(answer));
  const beat = setInterval(() => ws.ping(), BEAT);
  ws.on("close", () => {
    clearInterval(beat);
    // A dropped connection kills nothing: its commands go on, their stdin ended, their output dropped.
    for (const input of inputs.values()) input.then((writer) => writer.close()).catch(() => {});
  });
  ws.on("message", (data: Buffer, binary) => {
    if (binary) return received(unframe(data));
    let request: RunnerRequest;
    try {
      request = JSON.parse(String(data));
    } catch {
      return say({ op: "error", message: "a text frame is JSON" });
    }
    handle(request).catch((error: unknown) =>
      say({ op: "error", id: request.id, message: error instanceof Error ? error.message : String(error) }),
    );
  });

  async function handle(request: RunnerRequest): Promise<unknown> {
    switch (request.op) {
      case "run": {
        const { id, command, cwd, env, stdin } = request;
        const starting = box.run(command, { cwd, env, stdin });
        processes.set(id, starting);
        if (stdin)
          inputs.set(
            id,
            starting.then((started) => started.stdin.getWriter()),
          );
        try {
          const started = await starting;
          const pumped = Promise.all([pump(id, STDOUT, started.stdout), pump(id, STDERR, started.stderr)]);
          const { exitCode } = await started.wait();
          // Unless what it left running holds its pipes, what it printed last goes out first.
          await Promise.race([pumped, delay(LAST_OUTPUT)]);
          return say({ op: "exit", id, code: exitCode });
        } finally {
          processes.delete(id);
          inputs.delete(id);
        }
      }
      case "stdin-end": {
        const input = inputs.get(request.id);
        inputs.delete(request.id);
        return input?.then((writer) => writer.close()).catch(() => {});
      }
      case "kill":
        return processes.get(request.id)?.then((started) => started.kill(request.signal));
      case "read": {
        const file = await box.read(request.path);
        return file ? send(frame(request.id, FILE, file)) : say({ op: "absent", id: request.id });
      }
      case "write":
        return writes.set(request.id, request);
      case "stop":
        await box.stop();
        return say({ op: "ok", id: request.id });
      default:
        throw new Error(`no such request: ${(request as { op?: unknown }).op}`);
    }
  }

  function received({ id, stream, bytes }: ReturnType<typeof unframe>) {
    if (stream === STDIN)
      return void inputs
        .get(id)
        ?.then((writer) => writer.write(bytes))
        .catch(() => {});
    const write = writes.get(id);
    if (stream !== FILE || !write) return;
    writes.delete(id);
    box.write(write.path, bytes, { mode: write.mode }).then(
      () => say({ op: "ok", id }),
      (error: unknown) => say({ op: "error", id, message: error instanceof Error ? error.message : String(error) }),
    );
  }

  /** Sends what `from` prints, until it ends or fails. */
  async function pump(id: number, stream: number, from: ReadableStream<Uint8Array>) {
    try {
      for await (const chunk of from) send(frame(id, stream, chunk));
    } catch {
      // A pipe that failed has nothing more to say.
    }
  }
}
