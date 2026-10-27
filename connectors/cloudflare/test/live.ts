// By hand, against a real Cloudflare account: the Host and Wakeup kits against `cloudflare.container`
// and `cloudflare.alarm`, and the measured cold wake. Never in CI or the gate: it makes a Worker,
// a container application and their bills, takes about an hour (each stop is Cloudflare's own ten
// quiet minutes), and deletes both at the end. README, "Running it live", says what it needs:
//
//   pnpm build
//   SANOMA_LIVE=1 CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//     CLOUDFLARE_TEST_CHECKOUT=~/src/host-check-company CLOUDFLARE_TEST_DATABASE_URL=postgresql://... \
//     node connectors/cloudflare/test/live.ts

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestWorker, testDatabaseUrl } from "@sanoma-ai/testing";
import { checkHost, hostCheck, throughWorkflows, type Wake } from "@sanoma-ai/testing/host";
import { checkWakeup, wakeupCheckWorkflows } from "@sanoma-ai/testing/wakeup";
import { type CallContext, memoryLedger, memorySecrets, SanomaClient } from "@sanoma-ai/workflows";
import { mintInstanceToken } from "@sanoma-ai/workflows/wakeup-service";
import { alarm, container } from "../src/connector.ts";
import { cloudflareDriver } from "../src/driver.ts";
import { cloudflare } from "../src/index.ts";
import { HEALTH_PATH, INACTIVITY_MS } from "../src/worker.ts";

const NEEDS = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_TEST_CHECKOUT",
  "CLOUDFLARE_TEST_DATABASE_URL",
];
const missing = NEEDS.filter((name) => !process.env[name]);
if (process.env.SANOMA_LIVE !== "1" || missing.length) {
  console.error(
    `test/live.ts runs against a real account: SANOMA_LIVE=1 and ${missing.join(", ") || "nothing else"} are needed`,
  );
  process.exit(2);
}

const checkout = process.env.CLOUDFLARE_TEST_CHECKOUT!;
const companyDb = process.env.CLOUDFLARE_TEST_DATABASE_URL!;
const git = (...args: string[]) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
const { version } = JSON.parse(readFileSync(new URL("../../../packages/sanoma/package.json", import.meta.url), "utf8"));
const NAME = process.env.CLOUDFLARE_TEST_NAME ?? "host-check";
const COMPANY = "host-check-company";
const ID = "resources/hosts.ts#host";
/** Pinned on both sides, so the kits' client and the container's worker agree on the runs' version. */
const APP_VERSION = `cloudflare-live-${Date.now()}`;
process.env.DBOS__APPVERSION = APP_VERSION;

const ref = git("rev-parse", "--abbrev-ref", "HEAD");
const declared = {
  name: NAME,
  image: process.env.CLOUDFLARE_TEST_IMAGE ?? `ghcr.io/sanoma-ai/runtime:${version}`,
  source: git("remote", "get-url", "origin"),
  ref,
  port: 3000,
};
const token = mintInstanceToken();
const secrets = {
  HOST_DATABASE_URL: companyDb,
  HOST_SECRETS_KEY: randomBytes(32).toString("base64"),
  HOST_GITHUB_CLIENT_ID: "host-check-client",
  HOST_GITHUB_CLIENT_SECRET: "host-check-github-client-secret",
  HOST_APP_VERSION: APP_VERSION,
  HOST_WAKEUP_TOKEN: token,
};
const hostSecrets = {
  SANOMA_DATABASE_URL: "HOST_DATABASE_URL",
  SANOMA_SECRETS_KEY: "HOST_SECRETS_KEY",
  SANOMA_GITHUB_CLIENT_ID: "HOST_GITHUB_CLIENT_ID",
  SANOMA_GITHUB_CLIENT_SECRET: "HOST_GITHUB_CLIENT_SECRET",
  DBOS__APPVERSION: "HOST_APP_VERSION",
  SANOMA_WAKEUP_TOKEN: "HOST_WAKEUP_TOKEN",
};

const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Stops the container as Cloudflare does: nothing asks the Worker for its ten quiet minutes, and a minute more. */
async function quiet() {
  console.log(`waiting ${minutes(INACTIVITY_MS + 60_000)} for Cloudflare to stop the quiet container`);
  await sleep(INACTIVITY_MS + 60_000);
}

// The operator: a data file that declares the host, applied by a worker in this process with the
// real driver, on a local database of its own.
const root = mkdtempSync(join(tmpdir(), "sanoma-cloudflare-live-"));
mkdirSync(join(root, "resources"));
const secretLines = Object.entries(hostSecrets).map(([key, name]) => `    ${key}: secret(${JSON.stringify(name)}),`);
writeFileSync(
  join(root, "resources", "hosts.ts"),
  `import { cloudflare } from "@sanoma-ai/connector-cloudflare/resources";\nimport { secret } from "sanoma/resources";\n\n` +
    `export const host = cloudflare.container({\n${JSON.stringify(declared, null, 2).slice(2, -2)},\n` +
    `  secrets: {\n${secretLines.join("\n")}\n  },\n});\n\nexport default [host];\n`,
);
const operatorDb = testDatabaseUrl("cloudflare_live");
const operatorConfig = {
  workflows: [],
  connectors: [cloudflare],
  root,
  ledger: memoryLedger(),
  databaseUrl: operatorDb,
};
const worker = await startTestWorker(operatorConfig, { databaseUrl: operatorDb, quiet: true });
const operator = await SanomaClient.connect(operatorConfig);
for (const [name, value] of Object.entries(secrets)) await operator.setSecret(name, value, { by: "cloudflare-live" });

// The kits' client, on the company's database, under the company's name.
const companyRoot = mkdtempSync(join(tmpdir(), "sanoma-cloudflare-company-"));
writeFileSync(join(companyRoot, "package.json"), JSON.stringify({ name: COMPANY }));
const company = await SanomaClient.connect({
  workflows: [...wakeupCheckWorkflows],
  connectors: [hostCheck],
  root: companyRoot,
  databaseUrl: companyDb,
});

const driver = cloudflareDriver();
const alarmCall = memorySecrets({ SANOMA_WAKEUP_TOKEN: token });
let n = 0;
const op = (name: string, input: object, secretsOf = alarmCall) =>
  driver.ops[name]!(input, {
    idempotencyKey: `live:${++n}`,
    runId: "live",
    opId: `cloudflare.${name}`,
    attempt: 1,
    secrets: secretsOf,
  } satisfies CallContext) as Promise<any>;
const host = throughWorkflows(operator, ID, async (binding) => (await op("container.import", { id: binding })).state);

let failed = false;
const report = (kit: string, results: { name: string; ok: boolean; error?: string }[]) => {
  for (const r of results) console.log(`${kit}: ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.error ? `: ${r.error}` : ""}`);
  failed ||= results.some((r) => !r.ok);
};

let url = "";
try {
  const hostResults = await checkHost({
    type: container,
    apply: async () => {
      const state = await host.apply();
      url = String(state.url);
      return state;
    },
    stop: async () => void (await op("container.delete", { id: NAME })),
    suspend: quiet,
    client: company,
    secrets: Object.values(secrets),
    async commit() {
      git("commit", "--allow-empty", "-m", "host check");
      git("push", "origin", `HEAD:${ref}`);
      return git("rev-parse", "HEAD");
    },
    drift: host.drift,
    timeoutMs: 15 * 60_000,
  });
  report("host", hostResults);

  // The wakes the object rang, as the alarm's `rang` shows each: polled, since they happen at Cloudflare.
  const wakes: Wake[] = [];
  const poll = setInterval(async () => {
    try {
      const { state } = (await op("alarm.read", { id: url })) as {
        state?: { rang: string | null };
      };
      const rang = state?.rang ? new Date(state.rang) : undefined;
      if (rang && !wakes.some((w) => w.at.getTime() === rang.getTime())) wakes.push({ at: rang });
    } catch {
      // The next poll asks again.
    }
  }, 2_000);
  try {
    await op("alarm.create", { desired: { host: url } });
    report(
      "wakeup",
      await checkWakeup({
        type: alarm,
        host: { url, stop: quiet, wakes: () => wakes },
        client: company,
        register: async (registration) => void (await op("alarm.register", registration)),
        timeoutMs: 15 * 60_000,
      }),
    );
  } finally {
    clearInterval(poll);
  }

  await quiet();
  const begun = Date.now();
  const res = await fetch(`${url}${HEALTH_PATH}?start=1`);
  console.log(`cold wake: ${HEALTH_PATH} answered ${res.status} after ${((Date.now() - begun) / 1000).toFixed(1)} s`);
} finally {
  if (url) await op("alarm.delete", { id: url }).catch((error) => console.error(`alarm.delete: ${error}`));
  await op("container.delete", { id: NAME }).catch((error) => console.error(`container.delete: ${error}`));
  await company.close();
  await operator.close();
  await worker.stop();
  rmSync(root, { recursive: true, force: true });
  rmSync(companyRoot, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
