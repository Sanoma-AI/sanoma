import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { type Bridge, bridgeClient } from "./bridge.ts";
import { BridgeService } from "./gen/bridge/v1/bridge_pb.ts";

/** One JSON log line from the bridge's stderr (`slog`): `time`, `level`, `msg` and attributes. */
export interface BridgeLog {
  level?: string;
  msg?: string;
  [key: string]: unknown;
}

export interface StartBridgeOptions {
  /** The `provider-bridge` binary. Default: `SANOMA_BRIDGE_BIN` (see `pnpm bridge:download`). */
  bin?: string;
  /** Verified provider binaries and schemas. Default: the bridge's (`provider-bridge` in the user cache directory). */
  cacheDir?: string;
  /** The unix socket to serve on. Default: `bridge.sock` in a fresh temporary directory, removed on `stop`. */
  socketPath?: string;
  /**
   * Added to the bridge's environment, which is otherwise only `HOME`, `PATH`, the temp, cache,
   * proxy and TLS variables of this process: credentials reach providers through `configure`
   * only, never through the environment.
   */
  env?: Record<string, string>;
  /** More `serve` flags, such as `["--log-level", "debug"]` or `["--allow-host", "registry.example"]`. */
  args?: string[];
  /** Receives each stderr line. Default: warnings and errors go to `console.error`. */
  logger?: (line: BridgeLog) => void;
  /** How long to wait for the ready line. Default 30 seconds. */
  readyTimeoutMs?: number;
  /** Deadline of each call. Default: none (a first `schema` downloads the provider). */
  timeoutMs?: number;
  /** Connect interceptors around every call (the fake's recorder is one). */
  interceptors?: Interceptor[];
}

/** The variables the bridge inherits: what it needs to run, download and verify, nothing else. */
const INHERITED =
  /^(HOME|PATH|TMPDIR|USER|LOGNAME|XDG_CACHE_HOME|SSL_CERT_FILE|SSL_CERT_DIR|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy)$/;

const defaultLogger = (line: BridgeLog) => {
  if (line.level === "WARN" || line.level === "ERROR") console.error("provider-bridge:", line);
};

/**
 * Starts `provider-bridge serve` on a unix socket and connects to it. The bridge exits when this
 * process does (it watches stdin) or on `stop()`.
 */
export async function startBridge(options: StartBridgeOptions = {}): Promise<Bridge> {
  const bin = options.bin ?? process.env.SANOMA_BRIDGE_BIN;
  if (!bin) {
    throw new Error(
      "provider-bridge: no binary. Set SANOMA_BRIDGE_BIN (`pnpm bridge:download` builds one and prints the path) or pass `bin`.",
    );
  }
  const tempDir = options.socketPath ? undefined : mkdtempSync(join(tmpdir(), "sanoma-bridge-"));
  const socketPath = options.socketPath ?? join(tempDir!, "bridge.sock");
  const cleanup = () => tempDir && rmSync(tempDir, { recursive: true, force: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => INHERITED.test(name)));
  const args = ["serve", "--socket", socketPath, "--watch-stdin"];
  if (options.cacheDir) args.push("--cache-dir", options.cacheDir);
  args.push(...(options.args ?? []));

  const child = spawn(bin, args, { env: { ...env, ...options.env }, stdio: ["pipe", "pipe", "pipe"] });
  // Writing to (or ending) the stdin of a bridge that has died is EPIPE: its exit is what matters.
  child.stdin.on("error", () => {});
  const logger = options.logger ?? defaultLogger;
  const tail: string[] = [];
  createInterface({ input: child.stderr }).on("line", (text) => {
    tail.push(text);
    if (tail.length > 20) tail.shift();
    let line: BridgeLog;
    try {
      line = JSON.parse(text) as BridgeLog;
    } catch {
      line = { msg: text };
    }
    logger(line);
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  // Nobody need call `stop()` (the bridge is unref'd and dies with this process), so the socket's
  // directory goes when the bridge exits, or when this process does, whichever is first.
  process.once("exit", cleanup);
  child.once("exit", () => {
    cleanup();
    process.off("exit", cleanup);
  });

  try {
    await waitForReady(child, options.readyTimeoutMs ?? 30_000);
  } catch (error) {
    child.kill("SIGKILL");
    cleanup();
    const stderr = tail.length ? `\n${tail.join("\n")}` : "";
    throw new Error(`provider-bridge did not start: ${(error as Error).message}${stderr}`, { cause: error });
  }
  // The bridge dies with this process (EOF on its stdin), so it need not keep the process alive.
  child.unref();
  for (const pipe of [child.stdin, child.stdout, child.stderr]) (pipe as unknown as Socket).unref();

  const transport = createConnectTransport({
    httpVersion: "1.1",
    baseUrl: "http://bridge",
    nodeOptions: { socketPath },
    interceptors: options.interceptors ?? [],
  });
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.ref();
        child.stdin.end(); // EOF: the bridge stops its providers and removes the socket
        const timer = setTimeout(() => child.kill("SIGTERM"), 10_000);
        await exited;
        clearTimeout(timer);
      }
      cleanup();
    })());
  return bridgeClient(
    createClient(BridgeService, transport),
    stop,
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );
}

/** Resolves on the ready line `{"event":"ready","socket":...}`; rejects if the bridge exits or the time runs out. */
function waitForReady(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    const timer = setTimeout(() => done(new Error(`no ready line within ${timeoutMs} ms`)), timeoutMs);
    const onExit = (code: number | null, signal: string | null) =>
      done(new Error(`it exited (${signal ?? `code ${code}`}) before it was ready`));
    const onError = (error: Error) => done(error);
    function done(error?: Error) {
      clearTimeout(timer);
      child.off("exit", onExit).off("error", onError);
      lines.close();
      child.stdout!.resume(); // nothing more is expected; never let the pipe fill
      if (error) reject(error);
      else resolve();
    }
    child.on("exit", onExit).on("error", onError);
    lines.on("line", (text) => {
      try {
        if ((JSON.parse(text) as { event?: string }).event === "ready") done();
      } catch {
        // not the ready line
      }
    });
  });
}
