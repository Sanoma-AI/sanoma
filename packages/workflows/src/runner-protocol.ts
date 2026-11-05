// The runner's protocol, over one WebSocket per box, shared by the runner (`sandbox-runner.ts`)
// and its client (`runner-box.ts`): text frames for control, as JSON, each carrying the `id` of
// the process or the request it is about; binary frames for bytes, `frame(id, stream, bytes)`.

/** The port the runner listens on in a box. */
export const RUNNER_PORT = 7700;

/**
 * The protocol's version, which the runner's `GET /health` answers (`{ protocol }`): a backend
 * restarts a runner that answers another, one an earlier release started in a box that slept.
 */
export const RUNNER_PROTOCOL = 1;

/** What a binary frame's bytes are: a process's stdin, stdout or stderr, or a file read or written. */
export const STDIN = 0;
export const STDOUT = 1;
export const STDERR = 2;
export const FILE = 3;

/** What the client says, as text. A `write`'s bytes follow it as the frame `(id, FILE)`. */
export type RunnerRequest =
  | { op: "run"; id: number; command: string; cwd?: string; env?: Record<string, string>; stdin: boolean }
  | { op: "stdin-end"; id: number }
  | { op: "kill"; id: number; signal: NodeJS.Signals }
  | { op: "read"; id: number; path: string }
  | { op: "write"; id: number; path: string; mode?: number }
  | { op: "stop"; id: number };

/** What the runner answers, as text. A `read` that finds a file answers the frame `(id, FILE)`. */
export type RunnerAnswer =
  | { op: "exit"; id: number; code: number }
  | { op: "absent"; id: number }
  | { op: "ok"; id: number }
  | { op: "error"; id?: number; message: string };

/** A binary frame: `id` (4 bytes), `stream` (1 byte), then `bytes`. */
export function frame(id: number, stream: number, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const framed = new Uint8Array(5 + bytes.length);
  new DataView(framed.buffer).setUint32(0, id);
  framed[4] = stream;
  framed.set(bytes, 5);
  return framed;
}

export const unframe = (framed: Uint8Array) => ({
  id: new DataView(framed.buffer, framed.byteOffset, framed.byteLength).getUint32(0),
  stream: framed[4]!,
  bytes: framed.subarray(5),
});
