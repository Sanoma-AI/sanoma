// By hand, against a real sanoma-ops: the resource operations of `cloud.database` and
// `cloud.host` through the real driver, for a scratch company, and the Database kit's run checks
// when the company database's URL is given. Never in CI or the gate: it makes a Neon project and a
// Cloudflare Worker and container in Sanoma's accounts, and closes both at the end. README,
// "Running it live", says what it needs:
//
//   pnpm build
//   SANOMA_LIVE=1 SANOMA_CLOUD_TOKEN=sca_... SANOMA_CLOUD_TEST_REPOSITORY=Sanoma-AI/host-check-company \
//     [SANOMA_CLOUD_URL=https://www.sanoma.work] [SANOMA_CLOUD_TEST_SLUG=host-check] \
//     [SANOMA_CLOUD_TEST_DATABASE_URL=postgresql://...] node connectors/sanoma-cloud/test/live.ts

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { checkDatabase, databaseCheckConfig } from "sanoma/testing/database";
import { type CallContext, memorySecrets, SanomaClient } from "sanoma/workflows";
import { database } from "../src/connector.ts";
import { cloudDriver } from "../src/driver.ts";

const missing = ["SANOMA_CLOUD_TOKEN", "SANOMA_CLOUD_TEST_REPOSITORY"].filter((name) => !process.env[name]);
if (process.env.SANOMA_LIVE !== "1" || missing.length) {
  console.error(
    `test/live.ts runs against a real sanoma-ops: SANOMA_LIVE=1 and ${missing.join(", ") || "nothing else"} are needed`,
  );
  process.exit(2);
}

const SLUG = process.env.SANOMA_CLOUD_TEST_SLUG ?? "host-check";
const REPOSITORY = process.env.SANOMA_CLOUD_TEST_REPOSITORY!;
const SOURCE = `https://github.com/${REPOSITORY}.git`;
const REF = process.env.SANOMA_CLOUD_TEST_REF ?? "main";
const COMPANY_DB = process.env.SANOMA_CLOUD_TEST_DATABASE_URL;
const POLL_MS = 5_000;
const HEALTH_TIMEOUT_MS = 10 * 60_000;

// The kit's credential check stores one, encrypted with the key a worker has.
process.env.SANOMA_SECRETS_KEY ??= randomBytes(32).toString("base64");
process.env.SANOMA_SIGNING_KEY ??= randomBytes(32).toString("base64");

const driver = cloudDriver();
let n = 0;
const op = (name: string, input: object) =>
  driver.ops[name]!(input, {
    idempotencyKey: `live:${Date.now()}:${++n}`,
    runId: "live",
    opId: `cloud.${name}`,
    attempt: 1,
    secrets: memorySecrets(),
  } satisfies CallContext) as Promise<any>;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
/** The commit `ref` names on the repository now, as apply resolves it. */
const head = () => execFileSync("git", ["ls-remote", SOURCE, REF], { encoding: "utf8" }).split("\t")[0]!;

/** Answers of `url`'s `/healthz` until one is 200; how long that took. */
async function answers(url: string): Promise<number> {
  const begun = Date.now();
  for (;;) {
    const status = await fetch(new URL("/healthz", url)).then(
      (res) => res.status,
      () => 0,
    );
    if (status === 200) return Date.now() - begun;
    if (Date.now() - begun > HEALTH_TIMEOUT_MS) throw new Error(`${url}/healthz answered ${status} for too long`);
    await sleep(POLL_MS);
  }
}

let failed = false;
const made = { database: false, host: false };
try {
  const desiredDatabase = { name: SLUG, region: process.env.SANOMA_CLOUD_TEST_REGION ?? "us-east" };
  const begun = Date.now();
  const store = await op("database.create", { desired: desiredDatabase });
  made.database = true;
  console.log(`database: made ${store.state.id} in ${store.state.region} after ${seconds(Date.now() - begun)}`);

  const desiredHost = { name: SLUG, source: SOURCE, ref: REF, revision: head() };
  const started = Date.now();
  const host = await op("host.create", { desired: desiredHost });
  made.host = true;
  console.log(
    `host: made at ${host.state.url}, revision ${host.state.revision}, after ${seconds(Date.now() - started)}`,
  );
  console.log(`host: /healthz answered 200 after ${seconds(await answers(host.state.url))}`);

  const read = await op("host.read", { id: SLUG });
  if (read.gone || read.state.revision !== desiredHost.revision) {
    throw new Error(`host.read: ${JSON.stringify(read)}`);
  }
  const plan = await op("host.plan", { id: SLUG, desired: desiredHost });
  console.log(`host: plan at the same revision is ${plan.action}`);
  if (plan.action !== "none") failed = true;

  if (COMPANY_DB) {
    // Neon suspends a compute after five quiet minutes, which a client holding LISTEN never gives:
    // the suspend check is the fake's (test/database.test.ts).
    const type = { ...database, database: { ...database.database!, capabilities: { pauses: false, branch: false } } };
    const client = await SanomaClient.connect(databaseCheckConfig(COMPANY_DB));
    try {
      const results = await checkDatabase({
        type,
        apply: async () => (await op("database.read", { id: SLUG })).state,
        url: async () => COMPANY_DB,
        client,
        timeoutMs: 120_000,
      });
      for (const r of results) {
        console.log(`database: ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.error ? `: ${r.error}` : ""}`);
      }
      if (results.some((r) => !r.ok)) failed = true;
    } finally {
      await client.close();
    }
  } else {
    console.log("database: no SANOMA_CLOUD_TEST_DATABASE_URL, so the kit's run checks are skipped");
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  if (made.host) await op("host.delete", { id: SLUG }).catch((error) => console.error(`host.delete: ${error}`));
  if (made.database) {
    await op("database.delete", { id: SLUG }).catch((error) => console.error(`database.delete: ${error}`));
  }
}
process.exit(failed ? 1 : 0);
