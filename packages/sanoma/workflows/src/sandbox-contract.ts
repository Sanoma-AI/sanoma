import type { z } from "zod";
import { hasPath } from "./host.ts";
import type { LoginContext } from "./op.ts";

// The `Sandbox` contract: what a resource type that runs a coding agent's box (an Agent37
// instance) declares about itself, beside `Host`, `Database` and `Wakeup`, and the backend its
// connector attaches (`ConnectorSetup.sandbox`) to open one box per name, so boxes are swappable
// and one conformance kit decides whether one works. Vendor- and library-neutral: web streams,
// no AI SDK. (`sandbox.ts` is something else: a scenario's run over the fakes.)

/** What a sandbox can do, for choosing one: declared, never checked at runtime. */
export interface SandboxCapabilities {
  /** A box's files, its home's too, survive `stop` and the next `open` of its name. */
  snapshot: boolean;
  /** A stopped box keeps its memory and processes, and resumes them on the next `open`. */
  pause: boolean;
  /** `expose` makes a port of the box reachable from outside it. */
  port: boolean;
}

/** What a sandbox's state says of it. */
export interface SandboxOutputs {
  id: string;
  healthy: boolean;
}

/**
 * A resource type's `sandbox`: the fields its boxes' choices are in, by dotted path into its
 * declared fields, and how its state reads. The vendor's own facts (its region, its type of
 * machine) are fields of the resource, never read from the environment.
 */
export interface SandboxSpec {
  capabilities: SandboxCapabilities;
  inputs: {
    /**
     * The image a box runs: it holds `bash`, `git`, `node` (22 or later) and `pnpm` on its `PATH`,
     * which the agents and their installs run, or its backend puts them there at `open`.
     */
    image: string;
    /** A box's size, in vCPUs: its memory follows the vendor's shapes. */
    size: string;
  };
  outputs: (state: Record<string, unknown>) => SandboxOutputs;
}

/** A process `Box.run` started: `bash -c <command>`. */
export interface Process {
  /** Its stdin: closed at once unless `run` was given `stdin: true`. */
  stdin: WritableStream<Uint8Array>;
  /** Its stdout, as it prints, ended once it has exited. */
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  /** Resolves when it has exited: non-zero when it failed or was killed. */
  wait(): Promise<{ exitCode: number }>;
  /** Kills it and what it started (default `SIGKILL`). */
  kill(signal?: NodeJS.Signals): void;
}

/**
 * A box: a computer of its own a coding agent works in. A relative `path` or `cwd` is under the
 * box's home (`$HOME`), which a backend with `snapshot` keeps across `stop`.
 */
export interface Box {
  /** The vendor's id of it. */
  id: string;
  /** Runs `bash -c <command>`, in `cwd`, with `env` over the box's own. An abort kills it. */
  run(
    command: string,
    opts?: { cwd?: string; env?: Record<string, string>; stdin?: boolean; signal?: AbortSignal },
  ): Promise<Process>;
  /** A file's bytes; null when there is none. */
  read(path: string): Promise<Uint8Array | null>;
  /** Writes a file, its directories made. */
  write(path: string, bytes: Uint8Array, opts?: { mode?: number }): Promise<void>;
  /** Where its `port` is reached from outside it, with the headers that reach it. */
  expose(port: number): Promise<{ url: string; headers?: Record<string, string> }>;
  /** Stops it and every process in it; the next `open` of its name finds what it kept. */
  stop(): Promise<void>;
}

/**
 * A connector's boxes (`ConnectorSetup.sandbox`). A box is keyed by `name`, under which the
 * vendor keeps its state, so no snapshot handle crosses the contract.
 */
export interface SandboxBackend {
  /**
   * The box `name`, made from `image` with `size` vCPUs when there is none (left out, the backend's
   * own), woken or started when stopped.
   */
  open(opts: { name: string; image?: string; size?: number }): Promise<Box>;
  /** Deletes the box `name` and whatever the vendor kept of it: the next `open` finds it empty. */
  discard(opts: { name: string }): Promise<void>;
}

/**
 * What the app gives a connector's sandbox half (`ConnectorSetup.sandbox`): the secrets, as a model
 * half reads them, and the declared fields of the resource whose boxes it opens, which hold the
 * vendor's facts (its region, its type of machine) beside the image and size `open` takes.
 */
export type SandboxContext = Pick<LoginContext, "secrets"> & { declared: Record<string, unknown> };

/**
 * Throws what is wrong with a resource type's `sandbox`: a type apply cannot change (not
 * `writable`), a capability that is not a boolean, an input that names no field, `outputs` that
 * is not a function.
 */
export function checkSandbox(
  what: string,
  sandbox: SandboxSpec,
  type: { schema: z.ZodObject; writable?: boolean },
): void {
  const problems: string[] = [];
  if (!type.writable) problems.push("it must be writable, so apply can create and update it");
  const capabilities: Partial<SandboxCapabilities> = sandbox.capabilities ?? {};
  for (const name of ["snapshot", "pause", "port"] as const) {
    if (typeof capabilities[name] !== "boolean") problems.push(`capabilities.${name} must be true or false`);
  }
  for (const input of ["image", "size"] as const) {
    const path: unknown = sandbox.inputs?.[input];
    if (typeof path !== "string" || !hasPath(type.schema, path)) problems.push(`${input} names no field (${path})`);
  }
  if (typeof sandbox.outputs !== "function") problems.push("outputs must be a function of the state");
  if (problems.length) throw new Error(`${what}: its sandbox: ${problems.join("; ")}`);
}
