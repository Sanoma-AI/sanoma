// Build-time compatibility check against the image's actual bridge, using a provider with
// no credentials or external resources. Keep the protocol aligned with bridge.ts's negotiate.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const dir = await mkdtemp(join(tmpdir(), "sanoma-runtime-bridge-"));
const socketPath = join(dir, "bridge.sock");
const child = spawn(process.argv[2], ["serve", "--socket", socketPath, "--cache-dir", dir, "--watch-stdin"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const exited = once(child, "exit");
const deadline = AbortSignal.timeout(120_000);
const lines = createInterface({ input: child.stdout });
const provider = {
  source: "hashicorp/null",
  version: "3.3.2",
  sha256: "edab2c30932ca2a35c540352bc21844e7cf06cb7eb6c3eed4fd28d24d20e8d48",
};

function rpc(method, body) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: `/sanoma.providerbridge.v1.BridgeService/${method}`,
        method: "POST",
        headers: { "content-type": "application/json", "connect-protocol-version": "1" },
        signal: deadline,
      },
      async (res) => {
        try {
          let text = "";
          for await (const chunk of res) text += chunk;
          assert.equal(res.statusCode, 200, `${method}: ${text}`);
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

try {
  const [line] = await Promise.race([
    once(lines, "line", { signal: deadline }),
    exited.then(() => {
      throw new Error("bridge exited before ready");
    }),
  ]);
  assert.equal(JSON.parse(line).event, "ready");
  const schema = await rpc("GetSchema", { provider });
  assert.equal(schema.sessionProtocol, 1, "runtime bridge must support isolated session protocol 1");
  const sessions = [randomUUID(), randomUUID()].map((sessionId) => ({ ...provider, sessionId }));
  await Promise.all(sessions.map((ref) => rpc("Configure", { provider: ref, configJson: "{}" })));
  await Promise.all(sessions.map((ref) => rpc("Close", { provider: ref })));
  console.log("Runtime bridge: isolated session protocol 1, two concurrent sessions passed");
} finally {
  lines.close();
  child.stdin.on("error", () => {});
  child.stdin.end();
  const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(kill);
    await rm(dir, { recursive: true, force: true });
  }
}
