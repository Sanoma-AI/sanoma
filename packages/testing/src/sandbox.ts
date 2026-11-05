import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Box,
  defineConnector,
  defineResource,
  errorMessage,
  LOCAL_SANDBOX,
  localBackend,
  type SandboxBackend,
  type SandboxCapabilities,
  withSetup,
} from "@sanoma-ai/workflows";
import { z } from "zod";
import { waitFor } from "./build.ts";
import type { HostCheck } from "./host.ts";

// The conformance kit for the `Sandbox` contract: whether a backend's boxes are what a coding
// agent needs. `checkSandbox` opens a box by name and drives it through the contract alone, then
// reports each check. `fakeSandbox` is a backend whose boxes are directories on this machine and
// whose commands are its children, for the kit's own tests and for a config that needs a sandbox
// type (`testsandbox.box`) before a real one lands.

/** A sandbox backend under test, and what it opens. */
export interface SandboxUnderTest {
  backend: SandboxBackend;
  /** What it declares it can do: a check of `snapshot` or `port` runs only when it says so. */
  capabilities: SandboxCapabilities;
  /** The box the kit opens, and discards at its end. Default `sanoma-kit`. */
  name?: string;
  image: string;
  size: number;
  /** How long a check waits. Default 60 s. */
  timeoutMs?: number;
}

/** One check's outcome. */
export type SandboxCheck = HostCheck;

/** Where the kit writes, relative to the box's home. */
const WRITTEN = "sanoma-kit/written";
/** What a command of the kit's writes under `$HOME`. */
const HOMED = ".sanoma-kit";

/**
 * Runs the conformance checks against a backend, in order, each on its own (one failing goes on
 * to the next, but once no box opens the rest fail at once): stdout arrives before a command
 * exits, stdin reaches `cat`, a written file reads back (and runs, with its mode); with `snapshot`,
 * that file and one a command wrote under `$HOME` survive `stop` and the next `open`; with `port`,
 * a server in the box answers at what `expose` returns; a command killed mid-run exits non-zero;
 * `discard` leaves the next `open` empty. Starts from a discarded box, and discards it at the end.
 */
export async function checkSandbox(s: SandboxUnderTest): Promise<SandboxCheck[]> {
  const { backend, capabilities, name = "sanoma-kit", image, size, timeoutMs = 60_000 } = s;
  const token = randomBytes(9).toString("base64url");
  const script = new TextEncoder().encode(`#!/bin/sh\necho ${token}\n`);
  const results: SandboxCheck[] = [];
  const open = () => timed(backend.open({ name, image, size }), timeoutMs, "open");
  let opened: Box | undefined;
  const check = async (title: string, run: (box: Box) => Promise<void>) => {
    if (!opened) return void results.push({ name: title, ok: false, error: "no box opened" });
    try {
      await run(opened);
      results.push({ name: title, ok: true });
    } catch (err) {
      results.push({ name: title, ok: false, error: errorMessage(err) });
    }
  };
  const ran = async (at: Box, command: string) => {
    const done = await at.run(command);
    const [out, { exitCode }] = await timed(Promise.all([text(done.stdout), done.wait()]), timeoutMs, command);
    if (exitCode !== 0) throw new Error(`${command} exited ${exitCode}`);
    return out;
  };

  try {
    await backend.discard({ name });
    opened = await open();
    results.push({ name: "a box opens", ok: true });
  } catch (err) {
    results.push({ name: "a box opens", ok: false, error: errorMessage(err) });
  }
  try {
    await check("stdout arrives before the command exits", async (at) => {
      const started = await at.run("echo ready; sleep 30");
      try {
        const reader = started.stdout.getReader();
        const decoder = new TextDecoder();
        let said = "";
        while (!said.includes("ready\n")) {
          const { value, done } = await timed(reader.read(), timeoutMs, "the first output");
          if (done) throw new Error(`it printed ${JSON.stringify(said)} and ended`);
          said += decoder.decode(value, { stream: true });
        }
        const exited = await Promise.race([started.wait().then(() => true), delay(200).then(() => false)]);
        if (exited) throw new Error("it had exited before its output arrived");
        reader.releaseLock();
      } finally {
        started.kill();
      }
    });
    await check("stdin reaches cat", async (at) => {
      const cat = await at.run("cat", { stdin: true });
      const writer = cat.stdin.getWriter();
      await writer.write(new TextEncoder().encode(`${token}\n`));
      await writer.close();
      const [out, { exitCode }] = await timed(Promise.all([text(cat.stdout), cat.wait()]), timeoutMs, "cat");
      if (out !== `${token}\n` || exitCode !== 0)
        throw new Error(`cat printed ${JSON.stringify(out)}, exit ${exitCode}`);
    });
    await check("a written file reads back, and runs with its mode", async (at) => {
      await at.write(WRITTEN, script, { mode: 0o755 });
      if (!same(await at.read(WRITTEN), script)) throw new Error("it read back other bytes");
      if ((await ran(at, `./${WRITTEN}`)) !== `${token}\n`) throw new Error("it ran, but printed something else");
    });
    if (capabilities.snapshot) {
      await check("a file and the home directory survive a stop and the next open", async (at) => {
        await ran(at, `echo ${token} > "$HOME/${HOMED}"`);
        await at.stop();
        opened = undefined;
        const again = (opened = await open());
        if (!same(await again.read(WRITTEN), script)) throw new Error(`${WRITTEN} is gone`);
        if ((await ran(again, `cat "$HOME/${HOMED}"`)) !== `${token}\n`) throw new Error(`$HOME/${HOMED} is gone`);
      });
    }
    if (capabilities.port) {
      await check("an exposed port answers from outside the box", async (at) => {
        const port = 20_000 + Math.floor(Math.random() * 20_000);
        const server = await at.run(
          `node -e "require('node:http').createServer((q, s) => s.end('${token}')).listen(${port})"`,
        );
        try {
          const { url, headers } = await at.expose(port);
          const answer = () =>
            fetch(url, { headers, signal: AbortSignal.timeout(5_000) }).then(
              (res) => res.text(),
              () => "",
            );
          await waitFor(answer, (said) => said === token, timeoutMs);
        } finally {
          server.kill();
        }
      });
    }
    await check("a command killed mid-run exits non-zero", async (at) => {
      const sleeping = await at.run("sleep 30");
      sleeping.kill();
      const { exitCode } = await timed(sleeping.wait(), timeoutMs, "the killed command");
      if (exitCode === 0) throw new Error("it exited 0");
    });
    await check("discard leaves the next open empty", async (at) => {
      await at.stop();
      await backend.discard({ name });
      opened = undefined;
      const again = (opened = await open());
      if ((await again.read(WRITTEN)) !== null) throw new Error(`${WRITTEN} is still there`);
      if ((await ran(again, `test -e "$HOME/${HOMED}" && echo kept || true`)) !== "") {
        throw new Error(`$HOME/${HOMED} is still there`);
      }
    });
  } finally {
    await opened?.stop().catch(() => undefined);
    await backend.discard({ name }).catch(() => undefined);
  }
  return results;
}

/** `promise`, or an error naming `what` after `ms`. */
async function timed<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

const text = (stream: ReadableStream<Uint8Array>) => new Response(stream).text();

const same = (a: Uint8Array | null, b: Uint8Array) => a !== null && Buffer.from(a).equals(b);

const fakeSchema = z.object({ name: z.string().min(1), image: z.string().min(1), size: z.number().positive() });

/**
 * The fake sandbox's type, `testsandbox.box`: boxes on this machine, which `fakeSandbox`'s
 * backend opens, with the local backend's capabilities (`LOCAL_SANDBOX`).
 */
export const fakeSandboxType = defineResource({
  vendor: "testsandbox",
  type: "box",
  title: "Test box",
  identity: "name",
  schema: fakeSchema,
  fields: { immutable: ["name"], vendorOwned: [], writeOnly: [] },
  find: ({ name }) => name,
  bindingId: (state) => String(state.name),
  writable: true,
  sandbox: {
    capabilities: LOCAL_SANDBOX,
    inputs: { image: "image", size: "size" },
    outputs: (state) => ({ id: String(state.name), healthy: typeof state.name === "string" }),
  },
});

const types = defineConnector(
  "testsandbox",
  { box: fakeSandboxType },
  {
    title: "Test sandbox",
    // Only what a data file imports it from: no such package is published.
    package: "@sanoma-ai/testing-sandbox",
  },
);

/**
 * A sandbox backend on this machine, `localBackend` under `root`: the box `name` is the directory
 * `<root>/<name>`, its home (made by its first `open`), its commands `bash -c` children of this
 * process with that `HOME`. `connector` is `testsandbox` with this backend attached, for a config;
 * `remove()` deletes `root`.
 */
export function fakeSandbox(root = mkdtempSync(join(tmpdir(), "sanoma-sandbox-"))) {
  const backend = localBackend(root);
  return {
    type: fakeSandboxType,
    capabilities: LOCAL_SANDBOX,
    backend,
    connector: withSetup(types, { sandbox: () => backend }),
    root,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
