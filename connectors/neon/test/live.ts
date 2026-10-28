// By hand, against a real Neon organization: the Database kit against `neon.project` with the
// real driver, then how long a suspended compute takes to wake, measured. Never in CI or the
// gate: it makes a project in the key's organization (its plan's limits apply) and deletes it at
// the end. README, "Running it live", says what it needs:
//
//   pnpm build
//   SANOMA_LIVE=1 NEON_API_KEY=... node connectors/neon/test/live.ts

import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { checkDatabase, databaseCheckConfig } from "@sanoma-ai/testing/database";
import { type CallContext, memorySecrets, SanomaClient } from "@sanoma-ai/workflows";
import { project } from "../src/connector.ts";
import { neonDriver } from "../src/driver.ts";

if (process.env.SANOMA_LIVE !== "1" || !process.env.NEON_API_KEY) {
  console.error("test/live.ts runs against a real organization: SANOMA_LIVE=1 and NEON_API_KEY are needed");
  process.exit(2);
}

const NAME = process.env.NEON_TEST_NAME ?? "database-check";
const REGION = process.env.NEON_TEST_REGION ?? "aws-us-east-1";
const EXPORT = "store";
const POLL_MS = 2_000;
const COMPUTE_TIMEOUT_MS = 5 * 60_000;

// The kit's credential check stores one, encrypted with the key a worker has.
process.env.SANOMA_SECRETS_KEY ??= randomBytes(32).toString("base64");

const driver = neonDriver();
const secrets = memorySecrets();
let n = 0;
const op = (name: string, input: object) =>
  driver.ops[name]!(input, {
    idempotencyKey: `live:${++n}`,
    runId: "live",
    opId: `neon.${name}`,
    attempt: 1,
    secrets,
  } satisfies CallContext) as Promise<any>;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Polls `project.health` until the compute is in `state`, as apply's `afterCreate` does; how long that took. */
async function computeIs(id: string, state: string, when: string): Promise<number> {
  const begun = Date.now();
  for (;;) {
    const health = await op("project.health", { id });
    if (health.state === state) return Date.now() - begun;
    if (Date.now() - begun > COMPUTE_TIMEOUT_MS) {
      throw new Error(`${when}: the compute is still ${health.state} after ${seconds(Date.now() - begun)}`);
    }
    await sleep(POLL_MS);
  }
}

let id: string | undefined;
let client: SanomaClient | undefined;
let failed = false;
try {
  // As apply makes it: create, health until healthy, storeUrl.
  const begun = Date.now();
  ({ id } = await op("project.create", { desired: { name: NAME, region: REGION } }));
  console.log(`project ${id} created in ${REGION}, answered after ${seconds(Date.now() - begun)}`);
  console.log(`its compute started ${seconds(await computeIs(id!, "active", "after the create"))} after the create`);
  const [{ secret }, read] = await Promise.all([
    op("project.storeUrl", { id, export: EXPORT }),
    op("project.read", { id }),
  ]);
  const url = (await secrets.get(secret))!;
  const endpoint = read.state.default_endpoint_id as string;
  client = await SanomaClient.connect(databaseCheckConfig(url));

  // Neon drops the compute's connections as it answers the suspend; the kit's next start is the wake.
  const suspend = () => op("endpoint.suspend", { project: id, id: endpoint });
  const results = await checkDatabase({
    type: project,
    apply: async () => (await op("project.read", { id })).state,
    url: async () => url,
    suspend,
    client,
    timeoutMs: 120_000,
  });
  for (const r of results) {
    console.log(`database: ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.error ? `: ${r.error}` : ""}`);
  }
  failed = results.some((r) => !r.ok);

  // A suspended compute's wake, timed: with nothing connected (a client's listener reconnecting
  // would wake it), suspend, wait until Neon reads it idle, then connect as a worker does and query.
  await client.close();
  client = undefined;
  await suspend();
  console.log(`suspended: idle ${seconds(await computeIs(id!, "idle", "after the suspend"))} after the suspend`);
  const woke = Date.now();
  client = await SanomaClient.connect(databaseCheckConfig(url));
  const connected = Date.now() - woke;
  await client.runs({ limit: 1 });
  console.log(
    `wake: connected after ${seconds(connected)}, the first query answered after ${seconds(Date.now() - woke)}`,
  );
} finally {
  await client?.close();
  if (id) await op("project.delete", { id }).catch((error) => console.error(`project.delete: ${error}`));
}
process.exit(failed ? 1 : 0);
