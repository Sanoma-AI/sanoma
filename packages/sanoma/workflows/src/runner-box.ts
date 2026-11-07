import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  FILE,
  frame,
  RUNNER_HEALTH,
  type RunnerAnswer,
  type RunnerHealth,
  type RunnerRequest,
  STDERR,
  STDIN,
  unframe,
} from "./runner-protocol.ts";
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
    throw new Error(`${fileURLToPath(at)} is missing: build sanoma/workflows`);
  });
}

/**
 * What the runner at `url` (asked with `headers`) answers at `RUNNER_HEALTH`, or undefined when nothing
 * answers as a runner: a backend starts one then, and replaces one of another `protocol`.
 */
export const runnerHealth = (url: string, headers?: Record<string, string>): Promise<RunnerHealth | undefined> =>
  fetch(`${url}${RUNNER_HEALTH}`, { headers, signal: AbortSignal.timeout(5_000) })
    .then(async (res) => {
      const health = res.ok ? ((await res.json()) as Partial<RunnerHealth> | null) : null;
      return typeof health?.protocol === "number" && typeof health.pid === "number"
        ? { protocol: health.protocol, pid: health.pid }
        : undefined;
    })
    .catch(() => undefined);

const encoder = new TextEncoder();

/** Drops a write or close the reader no longer wants (it cancelled). */
const ignore = () => {};

/** What an id of the connection waits for: a process's output and exit, or a request's answer. */
interface Waiter {
  bytes(stream: number, bytes: Uint8Array): void;
  answer(answer: RunnerAnswer): void;
  /** The connection dropped. */
  lost(): void;
}

/** An open connection to the runner, and what its ids wait for. */
interface Connection {
  ws: WebSocket;
  waiting: Map<number, Waiter>;
}

/** How long the runner's WebSocket may take to open, in ms. */
const OPEN_MS = 30_000;

/**
 * The box `id` whose runner is at `url` (`http(s)://`, the WebSocket's upgrade sent with
 * `headers`): its commands, files and `stop` (which kills every command in it and closes the
 * connection). Connects at the first call, and again at the next call after a drop or a `stop`.
 * How its ports are reached is the vendor's, so the backend adds `expose`.
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
  let current: Promise<Connection> | undefined;
  let last = 0;

  const connect = () => (current ??= open());
  function open(): Promise<Connection> {
    const opening = new Promise<Connection>((resolve, reject) => {
      // Node's WebSocket (undici) takes `headers` beside the standard's protocols.
      const ws = new WebSocket(url.replace(/^http/, "ws"), { headers } as unknown as string[]);
      ws.binaryType = "arraybuffer";
      const connection: Connection = { ws, waiting: new Map() };
      const late = setTimeout(() => ws.close(), OPEN_MS);
      ws.addEventListener("open", () => {
        clearTimeout(late);
        resolve(connection);
      });
      ws.addEventListener("message", ({ data }: { data: string | ArrayBuffer }) => {
        try {
          if (typeof data !== "string") {
            const { id: of, stream, bytes } = unframe(new Uint8Array(data));
            return connection.waiting.get(of)?.bytes(stream, bytes);
          }
          const answer = JSON.parse(data) as RunnerAnswer;
          if (answer.id !== undefined) connection.waiting.get(answer.id)?.answer(answer);
        } catch {
          // A frame that is not the protocol's (another runner's) is dropped.
        }
      });
      ws.addEventListener("close", ({ code, reason }) => {
        clearTimeout(late);
        if (current === opening) current = undefined;
        reject(new Error(`${where} closed the connection (${reason || code})`));
        for (const waiter of connection.waiting.values()) waiter.lost();
        connection.waiting.clear();
      });
    });
    return opening;
  }

  /** Sends `request` (and `bytes` after it): resolves with the file it answers, null for none, or nothing for `ok`. */
  async function ask(
    request: { op: "read"; path: string } | { op: "write"; path: string; mode?: number } | { op: "stop" },
    bytes?: Uint8Array,
  ): Promise<Uint8Array | null | undefined> {
    const { ws, waiting } = await connect();
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
      const { ws, waiting } = await connect();
      const n = ++last;
      const stdout = new TransformStream<Uint8Array, Uint8Array>();
      const stderr = new TransformStream<Uint8Array, Uint8Array>();
      const out = stdout.writable.getWriter();
      const err = stderr.writable.getWriter();
      const exited = new Promise<{ exitCode: number }>((done) => {
        const end = (exitCode: number) => {
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
            err.write(encoder.encode(`${where}: ${answer.message}\n`)).catch(ignore);
            end(127);
          },
          lost: () => end(255),
        });
      });
      ws.send(JSON.stringify({ op: "run", id: n, command, cwd, env, stdin } satisfies RunnerRequest));
      const kill = (sig: NodeJS.Signals = "SIGKILL") => {
        if (waiting.has(n)) ws.send(JSON.stringify({ op: "kill", id: n, signal: sig } satisfies RunnerRequest));
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
      // This connection, not one a call opens meanwhile after a drop.
      const closing = connect();
      try {
        await ask({ op: "stop" });
      } finally {
        // The next call opens a new connection, not this closing one.
        if (current === closing) current = undefined;
        (await closing.catch(() => undefined))?.ws.close();
      }
    },
  };
}
