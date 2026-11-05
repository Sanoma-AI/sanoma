import { createPrivateKey, createPublicKey, hkdfSync, randomBytes } from "node:crypto";
import { constants } from "node:os";
import { Readable, Writable } from "node:stream";
import type { Box, Process } from "@sanoma-ai/workflows";
import { Client, type ClientChannel } from "ssh2";
import { createWebSocketStream, WebSocket } from "ws";

// A box's commands and files over SSH: Agent37 injects an SSH server into every instance, reached
// through a WebSocket at the instance's port 22022 (its `agent37 tunnel`), which carries the SSH
// byte stream as binary frames. `ssh2` speaks SSH over `ws`'s stream of it, in this process: one
// connection per open box, one exec channel per command.

/** Who a box's commands run as: the image's user on Agent37's templates, whose home is the instance's disk. */
const USER = "node";

/**
 * The SSH key the connector logs in to boxes with: an ed25519 key derived from the API key, so
 * nothing is kept and every process with the key has the same one, registered once per workspace.
 * It guards nothing the API key does not: that key runs any command in a box as root (`exec`).
 * The private key is OpenSSH's format, which is the one `ssh2` reads an ed25519 key in.
 */
export function sshKey(apiKey: string): { privateKey: string; publicKey: string } {
  const seed = Buffer.from(hkdfSync("sha256", apiKey, "", "sanoma agent37 ssh key", 32));
  // PKCS #8 for an Ed25519 seed (RFC 8410): a fixed prefix, then the 32 bytes.
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const spki = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({
    format: "der",
    type: "spki",
  });
  const pub = spki.subarray(-32);
  const type = Buffer.from("ssh-ed25519");
  const blob = Buffer.concat([str(type), str(pub)]);
  // OpenSSH's private key format (PROTOCOL.key), unencrypted: the check number twice, the key,
  // its comment, then padding to a multiple of 8.
  const check = seed.subarray(0, 4);
  const secret = Buffer.concat([check, check, str(type), str(pub), str(Buffer.concat([seed, pub])), str("sanoma")]);
  const padding = Buffer.from(Array.from({ length: (8 - (secret.length % 8)) % 8 }, (_, i) => i + 1));
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    str("none"),
    str("none"),
    str(""),
    uint32(1),
    str(blob),
    str(Buffer.concat([secret, padding])),
  ]);
  const lines = body
    .toString("base64")
    .match(/.{1,70}/g)!
    .join("\n");
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${blob.toString("base64")} sanoma`,
  };
}

const uint32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
/** An SSH string: its length, then its bytes. */
const str = (s: Buffer | string) => {
  const b = Buffer.from(s);
  return Buffer.concat([uint32(b.length), b]);
};

/** A tunnel or a login that a wait does not change: the edge refused the key, or the server the SSH key. */
export class RefusedError extends Error {}

/**
 * An SSH connection as `USER` to the server behind the WebSocket at `url` (`https://`, sent with
 * `headers`), within `timeoutMs`. The host key is not checked: the instance makes a new one when
 * Agent37 moves it, and the tunnel is TLS to Agent37's edge, which checked the API key. Fails
 * with a `RefusedError` when the edge refuses the key (401, 403, 404) or the server the SSH key.
 */
export function connect(
  url: string,
  headers: Record<string, string>,
  privateKey: string,
  timeoutMs: number,
): Promise<Client> {
  return new Promise((resolve, reject) => {
    // A dropped connection, or one torn down here, ends the commands on it: each one's `wait` says so.
    const client = new Client().on("error", () => {});
    const ws = new WebSocket(url, { headers, handshakeTimeout: timeoutMs });
    const fail = (error: Error & { level?: string }) => {
      client.end();
      ws.terminate();
      const refused =
        error.level === "client-authentication" || /Unexpected server response: 40[134]\b/.test(error.message);
      const message = `the SSH tunnel to ${new URL(url).host} failed: ${error.message}`;
      reject(refused ? new RefusedError(message) : new Error(message));
    };
    ws.once("error", fail);
    ws.once("open", () => {
      ws.off("error", fail);
      client.once("error", fail);
      client.once("ready", () => {
        client.off("error", fail);
        resolve(client);
      });
      client.connect({
        sock: createWebSocketStream(ws),
        username: USER,
        privateKey,
        readyTimeout: timeoutMs,
        // Bytes through the tunnel keep the instance awake while a box is open.
        keepaliveInterval: 30_000,
        hostVerifier: () => true,
      });
    });
  });
}

/** `s` as one word of a POSIX shell's command line. */
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The command line that runs `command` as the contract says, `bash -c` in `cwd` under the home,
 * with `env`: in a process group of its own (`set -m`), whose leader's pid goes to `pidfile` so
 * `kill` can signal the whole group, and whose exit status is the line's. The job's stdin is the
 * channel's; the shell's notice of a job killed is not printed.
 */
function commandLine(
  command: string,
  { cwd, env = {}, pidfile }: { cwd?: string; env?: Record<string, string>; pidfile: string },
): string {
  for (const name of Object.keys(env))
    if (!NAME.test(name)) throw new Error(`${name} is no environment variable's name`);
  const setup = [
    // The home, whatever directory the server starts a command in.
    "cd",
    ...(cwd ? [`cd -- ${quote(cwd)}`] : []),
    ...Object.entries(env).map(([name, value]) => `export ${name}=${quote(value)}`),
  ].join(" && ");
  const wrapper = `${setup} || exit 1; set -m; bash -c "$0" & p=$!; set +m; echo $p > "$1"; { wait $p; } 2>/dev/null; s=$?; rm -f "$1"; exit $s`;
  return `bash -c ${quote(wrapper)} ${quote(command)} ${quote(pidfile)}`;
}

/** The command line that sends `signal` to the group whose leader's pid is in `pidfile`, once it is there (up to 5 s). */
const killLine = (pidfile: string, signal: string) =>
  `f=${quote(pidfile)}; i=0; while [ ! -s "$f" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; ` +
  `kill -s ${signal.replace(/^SIG/, "")} -- -"$(cat "$f" 2>/dev/null)" 2>/dev/null; true`;

/** Opens an exec channel for `line`. */
const exec = (client: Client, line: string) =>
  new Promise<ClientChannel>((resolve, reject) =>
    client.exec(line, (error, channel) => (error ? reject(error) : resolve(channel))),
  );

/** Runs `line` to its end, `input` its stdin: its stdout, stderr and exit status (255 when the connection dropped). */
async function once(client: Client, line: string, input?: Uint8Array) {
  const channel = await exec(client, line);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  channel.on("data", (chunk: Buffer) => out.push(chunk));
  channel.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  const code = new Promise<number>((done) => {
    let status = 255;
    channel.on("exit", (exitCode: number | null) => (status = exitCode ?? 255));
    channel.on("close", () => done(status));
  });
  channel.end(input);
  return { status: await code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString().trim() };
}

/** The exit status `read` ends with when there is no file. */
const ABSENT = 44;

/**
 * A box's commands and files over `client`: `run` an exec channel per command (`commandLine`),
 * `read` and `write` a `cat` each, and `end`, which kills the process groups of the commands
 * still running and closes the connection. A relative path or `cwd` is under the home.
 */
export function sshBox(client: Client): Pick<Box, "run" | "read" | "write"> & { end(): Promise<void> } {
  /** The pidfiles of the commands still running. */
  const running = new Set<string>();
  return {
    async end() {
      const groups = [...running].map((f) => `kill -s KILL -- -"$(cat ${quote(f)} 2>/dev/null)" 2>/dev/null`);
      if (groups.length) await once(client, `${groups.join("; ")}; true`).catch(() => undefined);
      client.end();
    },
    async run(command, { cwd, env, stdin, signal } = {}): Promise<Process> {
      const pidfile = `/tmp/sanoma-run-${randomBytes(8).toString("hex")}`;
      const channel = await exec(client, commandLine(command, { cwd, env, pidfile }));
      running.add(pidfile);
      let status: number | undefined;
      let closed = false;
      channel.on("exit", (code: number | null, name?: string) => {
        status = code ?? 128 + ((name && constants.signals[`SIG${name}` as NodeJS.Signals]) || 1);
      });
      const exited = new Promise<{ exitCode: number }>((done) =>
        channel.on("close", () => {
          closed = true;
          running.delete(pidfile);
          // No status: the connection dropped, and the command with it.
          done({ exitCode: status ?? 255 });
        }),
      );
      if (!stdin) channel.end();
      const kill = (sig: NodeJS.Signals = "SIGKILL") => {
        if (closed) return;
        client.exec(killLine(pidfile, sig), (error, killer) => {
          // No second channel: closing this one is what is left.
          if (error) return void channel.close();
          killer.resume();
          killer.stderr.resume();
        });
      };
      const onAbort = () => kill();
      if (signal?.aborted) onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      void exited.then(() => signal?.removeEventListener("abort", onAbort));
      return {
        stdin: Writable.toWeb(channel) as WritableStream<Uint8Array>,
        stdout: Readable.toWeb(channel) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(channel.stderr) as ReadableStream<Uint8Array>,
        wait: () => exited,
        kill,
      };
    },
    async read(path) {
      const { status, stdout, stderr } = await once(
        client,
        `cd && if [ -e ${quote(path)} ]; then exec cat -- ${quote(path)}; else exit ${ABSENT}; fi`,
      );
      if (status === ABSENT) return null;
      if (status !== 0) throw new Error(`${path} could not be read (exit ${status}): ${stderr}`);
      return stdout;
    },
    async write(path, bytes, { mode } = {}) {
      const p = quote(path);
      const chmod = mode === undefined ? "" : ` && chmod ${mode.toString(8)} ${p}`;
      const { status, stderr } = await once(
        client,
        `cd && mkdir -p -- "$(dirname -- ${p})" && cat > ${p}${chmod}`,
        bytes,
      );
      if (status !== 0) throw new Error(`${path} could not be written (exit ${status}): ${stderr}`);
    },
  };
}
