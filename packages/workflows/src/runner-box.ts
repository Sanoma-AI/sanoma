import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FILE, frame, type RunnerAnswer, type RunnerRequest, STDERR, STDIN, unframe } from "./runner-protocol.ts";
import type { Box, Process } from "./sandbox-contract.ts";

// A box whose commands and files go through the runner (`sandbox-runner.ts`), a small server of
// ours a backend starts inside a remote box, over one WebSocket: so every vendor's backend is
// "open the box, start the runner, talk to it", whatever the vendor's own exec can or cannot
// stream. The protocol is in `runner-protocol.ts`. One connection carries many processes; a
// dropped one ends them here (exit 255) but kills nothing in the box.

/**
 * The runner as one file (`dist/sandbox-runner.cjs`, its dependencies bundled in), which a
 * backend writes into a box and starts with the box's `node` (22 or later).
 */
export async function runnerScript(): Promise<Uint8Array> {
  // `../dist/` from `src/` (the tests) and from `dist/` alike.
  const at = new URL("../dist/sandbox-runner.cjs", import.meta.url);
  return readFile(at).catch(() => {
    throw new Error(`${fileURLToPath(at)} is missing: build @sanoma-ai/workflows`);
  });
}

/** Drops a write or close the reader no longer wants (it cancelled). */
const ignore = () => {};

/** What an id of the connection waits for: a process's output and exit, or a request's answer. */
interface Waiter {
  bytes(stream: number, bytes: Uint8Array): void;
  answer(answer: RunnerAnswer): void;
  /** The connection dropped. */
  lost(): void;
}

/**
 * The box `id` whose runner is at `url` (`http(s)://`, the WebSocket's upgrade sent with
 * `headers`): its commands, files and `stop` (which kills every command in it and closes the
 * connection). Connects at the first call, and again at the next call after a drop. How its ports
 * are reached is the vendor's, so the backend adds `expose`.
 */
export function runnerBox({
  url,
  headers,
  id,
}: {
  url: string;
  headers?: Record<string, string>;
  id: string;
}): Omit<Box, "expose"> {
  const where = `the runner at ${new URL(url).host}`;
  let socket: Promise<WebSocket> | undefined;
  let last = 0;
  const waiting = new Map<number, Waiter>();

  const connect = () => (socket ??= open());
  function open(): Promise<WebSocket> {
    const opening = new Promise<WebSocket>((resolve, reject) => {
      // Node's WebSocket (undici) takes `headers` beside the standard's protocols.
      const ws = new WebSocket(url.replace(/^http/, "ws"), { headers } as unknown as string[]);
      ws.binaryType = "arraybuffer";
      ws.addEventListener("open", () => resolve(ws));
      ws.addEventListener("message", ({ data }: { data: string | ArrayBuffer }) => {
        if (typeof data !== "string") {
          const { id: of, stream, bytes } = unframe(new Uint8Array(data));
          return waiting.get(of)?.bytes(stream, bytes);
        }
        const answer = JSON.parse(data) as RunnerAnswer;
        if (answer.id !== undefined) waiting.get(answer.id)?.answer(answer);
      });
      ws.addEventListener("close", ({ code, reason }) => {
        if (socket === opening) socket = undefined;
        reject(new Error(`${where} closed the connection (${reason || code})`));
        for (const waiter of waiting.values()) waiter.lost();
        waiting.clear();
      });
    });
    return opening;
  }

  /** Sends `request` (and `bytes` after it): resolves with the file it answers, null for none, or nothing for `ok`. */
  async function ask(
    request: { op: "read"; path: string } | { op: "write"; path: string; mode?: number } | { op: "stop" },
    bytes?: Uint8Array,
  ): Promise<Uint8Array | null | undefined> {
    const ws = await connect();
    const n = ++last;
    return new Promise((resolve, reject) => {
      const settle = (done: () => void) => {
        waiting.delete(n);
        done();
      };
      waiting.set(n, {
        bytes: (_, file) => settle(() => resolve(file)),
        answer: (answer) =>
          settle(() =>
            answer.op === "error"
              ? reject(new Error(`${where}: ${answer.message}`))
              : resolve(answer.op === "absent" ? null : undefined),
          ),
        lost: () => reject(new Error(`${where} closed the connection`)),
      });
      ws.send(JSON.stringify({ ...request, id: n }));
      if (bytes) ws.send(frame(n, FILE, bytes));
    });
  }

  return {
    id,
    async run(command, { cwd, env, stdin = false, signal } = {}): Promise<Process> {
      const ws = await connect();
      const n = ++last;
      const stdout = new TransformStream<Uint8Array, Uint8Array>();
      const stderr = new TransformStream<Uint8Array, Uint8Array>();
      const out = stdout.writable.getWriter();
      const err = stderr.writable.getWriter();
      let ended = false;
      const exited = new Promise<{ exitCode: number }>((done) => {
        const end = (exitCode: number) => {
          ended = true;
          waiting.delete(n);
          out.close().catch(ignore);
          err.close().catch(ignore);
          done({ exitCode });
        };
        waiting.set(n, {
          bytes: (stream, bytes) => void (stream === STDERR ? err : out).write(bytes).catch(ignore),
          answer(answer) {
            if (answer.op === "exit") return end(answer.code);
            if (answer.op !== "error") return;
            err.write(new TextEncoder().encode(`${where}: ${answer.message}\n`)).catch(ignore);
            end(127);
          },
          lost: () => end(255),
        });
      });
      ws.send(JSON.stringify({ op: "run", id: n, command, cwd, env, stdin } satisfies RunnerRequest));
      const kill = (sig: NodeJS.Signals = "SIGKILL") => {
        if (!ended) ws.send(JSON.stringify({ op: "kill", id: n, signal: sig } satisfies RunnerRequest));
      };
      const onAbort = () => kill();
      if (signal?.aborted) onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      void exited.then(() => signal?.removeEventListener("abort", onAbort));
      const endInput = () => void ws.send(JSON.stringify({ op: "stdin-end", id: n } satisfies RunnerRequest));
      return {
        stdin: new WritableStream<Uint8Array>({
          write(bytes) {
            if (!stdin) throw new Error("its stdin is closed: run it with stdin: true");
            ws.send(frame(n, STDIN, bytes));
          },
          close: endInput,
          abort: endInput,
        }),
        stdout: stdout.readable,
        stderr: stderr.readable,
        wait: () => exited,
        kill,
      };
    },
    read: async (path) => (await ask({ op: "read", path })) ?? null,
    async write(path, bytes, { mode } = {}) {
      await ask({ op: "write", path, mode }, bytes);
    },
    async stop() {
      await ask({ op: "stop" });
      (await socket)?.close();
    },
  };
}
