import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Bridge, startBridge } from "@sanoma-ai/bridge";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import {
  checkHost,
  dockerAvailable,
  hostCheck,
  hostCheckWorkflows,
  testRepository,
  throughWorkflows,
} from "@sanoma-ai/testing/host";
import {
  allowAll,
  type CallContext,
  memoryLedger,
  memorySecrets,
  type Resource,
  SanomaClient,
  type SanomaConfig,
  withSetup,
  type Worker,
} from "@sanoma-ai/workflows";
import { startTestWorker } from "@sanoma-ai/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerOps, dockerTf } from "../src/connector.ts";
import { dockerDriver } from "../src/driver.ts";

// Needs Docker, Postgres (`pnpm db:up`), network for the container's `pnpm install`, and
// SANOMA_BRIDGE_BIN: skipped without them. The conformance kit against `docker.container` on the
// local daemon, driven by the real apply and drift workflows on an operator's worker (its own
// database). The container runs the runtime image (`sanoma-runtime:dev`, built from
// packages/sanoma/runtime when missing) on a company repository served over git from a bare
// repository here, installing this checkout's packages, packed: the kit's workflows on a database
// of its own, which the kit's client reads.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const IMAGE = "sanoma-runtime:dev";
const NAME = "sanoma-test-host";
const COMPANY = "host-check-company";
const ID = "resources/hosts.ts#host";
/** Pinned on both sides, so the kit's client and the container's worker agree on the runs' version. */
const APP_VERSION = "host-check";
const bin = process.env.SANOMA_BRIDGE_BIN;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });

/** A database URL as the container reaches it: this machine is host.docker.internal there. */
const inContainer = (url: string) => url.replace(/@(localhost|127\.0\.0\.1):/, "@host.docker.internal:");

const call: CallContext = { idempotencyKey: "host", runId: "host", opId: "host", attempt: 1, secrets: memorySecrets() };

describe.skipIf(!dockerAvailable() || !bin)("docker.container meets the Host contract", () => {
  const repo = testRepository();
  const work = repo.git("rev-parse", "--show-toplevel");
  const root = mkdtempSync(join(tmpdir(), "sanoma-docker-host-"));
  const companyRoot = mkdtempSync(join(tmpdir(), "sanoma-docker-company-"));
  const operatorDb = testDatabaseUrl("docker_host");
  const companyDb = testDatabaseUrl("docker_company");
  const secrets = {
    HOST_DATABASE_URL: inContainer(companyDb),
    HOST_SECRETS_KEY: process.env.SANOMA_SECRETS_KEY!,
    HOST_GITHUB_CLIENT_SECRET: "host-check-github-client-secret",
  };
  const env = { ...process.env };
  let daemon: ChildProcess | undefined;
  let bridge: Bridge;
  let worker: Worker | undefined;
  let operator: SanomaClient | undefined;
  let company: SanomaClient | undefined;
  let driver: ReturnType<typeof dockerDriver>;
  const op = (name: string, input: object) => driver.ops[`container.${name}`]!(input, call) as Promise<any>;

  beforeAll(async () => {
    if (spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status !== 0) {
      execFileSync("docker", ["build", "-t", IMAGE, join(repoRoot, "packages/sanoma/runtime")], { stdio: "inherit" });
    }
    // The company: the fixture with this checkout's packages, packed, and a lockfile.
    cpSync(fileURLToPath(new URL("./fixtures/company/", import.meta.url)), work, { recursive: true });
    const vendor = join(work, "vendor");
    for (const pkg of ["workflows", "app", "bridge", "sanoma"]) {
      execFileSync("pnpm", ["pack", "--pack-destination", vendor], {
        cwd: join(repoRoot, "packages", pkg),
        stdio: "ignore",
      });
    }
    for (const file of readdirSync(vendor))
      cpSync(join(vendor, file), join(vendor, file.replace(/-\d+\.\d+\.\d+\.tgz$/, ".tgz")));
    for (const file of readdirSync(vendor).filter((f) => /-\d+\.\d+\.\d+\.tgz$/.test(f))) rmSync(join(vendor, file));
    execFileSync("pnpm", ["install", "--lockfile-only"], { cwd: work, stdio: "ignore" });
    repo.git("add", "-A");
    await repo.commit();

    // Served over git: the container clones `git://host.docker.internal:<port>/source.git`, which
    // this process's git (resolving the ref) reads at 127.0.0.1.
    const gitPort = await freePort();
    const base = dirname(fileURLToPath(repo.url));
    daemon = spawn(
      "git",
      ["daemon", "--export-all", "--reuseaddr", `--base-path=${base}`, "--listen=127.0.0.1", `--port=${gitPort}`],
      {
        stdio: "ignore",
      },
    );
    const source = `git://host.docker.internal:${gitPort}/source.git`;
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.git://127.0.0.1:${gitPort}/.insteadOf`,
      GIT_CONFIG_VALUE_0: `git://host.docker.internal:${gitPort}/`,
      DBOS__APPVERSION: APP_VERSION,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The operator: a data file that declares the container, applied by its worker.
    mkdirSync(join(root, "resources"));
    const declared = {
      name: NAME,
      image: IMAGE,
      source,
      ref: "main",
      port: await freePort(),
    };
    const secretsOf = Object.entries({
      SANOMA_DATABASE_URL: "HOST_DATABASE_URL",
      SANOMA_SECRETS_KEY: "HOST_SECRETS_KEY",
      SANOMA_GITHUB_CLIENT_SECRET: "HOST_GITHUB_CLIENT_SECRET",
    })
      .map(([key, name]) => `    ${key}: secret(${JSON.stringify(name)}),`)
      .join("\n");
    writeFileSync(
      join(root, "resources", "hosts.ts"),
      `import { docker } from "@sanoma-ai/connector-docker/resources";\nimport { secret } from "sanoma/resources";\n\n` +
        `export const host = docker.container({\n${JSON.stringify(declared, null, 2).slice(2, -2)},\n  secrets: {\n${secretsOf}\n` +
        // Not secrets: the sign-in `sanoma serve` needs on 0.0.0.0, and the pinned version.
        `    SANOMA_GITHUB_CLIENT_ID: secret("HOST_GITHUB_CLIENT_ID"),\n    SANOMA_GITHUB_REPO: secret("HOST_GITHUB_REPO"),\n` +
        `    DBOS__APPVERSION: secret("HOST_APP_VERSION"),\n  },\n});\n\nexport default [host];\n`,
    );
    bridge = await startBridge({ bin });
    driver = dockerDriver({ bridge });
    const config: SanomaConfig = {
      workflows: [],
      connectors: [withSetup(dockerOps, { driver: () => driver })],
      policy: allowAll,
      root,
      ledger: memoryLedger(),
      databaseUrl: operatorDb,
    };
    worker = await startTestWorker(config, { databaseUrl: operatorDb, quiet: true });
    operator = await SanomaClient.connect(config);
    const by = { by: "host-check" };
    for (const [name, value] of Object.entries({
      ...secrets,
      HOST_GITHUB_CLIENT_ID: "host-check-client",
      HOST_GITHUB_REPO: "sanoma-test/company",
      HOST_APP_VERSION: APP_VERSION,
    })) {
      await operator.setSecret(name, value, by);
    }

    // The kit's client, on the company's database, under the company's name.
    writeFileSync(join(companyRoot, "package.json"), JSON.stringify({ name: COMPANY }));
    company = await SanomaClient.connect({
      workflows: [...hostCheckWorkflows],
      connectors: [hostCheck],
      policy: allowAll,
      root: companyRoot,
      databaseUrl: companyDb,
    });
  }, 900_000);

  afterAll(async () => {
    spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
    await company?.close();
    await operator?.close();
    await worker?.stop();
    await bridge?.stop();
    daemon?.kill();
    for (const name of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "DBOS__APPVERSION"]) {
      if (env[name] === undefined) delete process.env[name];
      else process.env[name] = env[name];
    }
    repo.remove();
    rmSync(root, { recursive: true, force: true });
    rmSync(companyRoot, { recursive: true, force: true });
  }, 120_000);

  it("passes every check, with no secret in the operator's ledger either", async () => {
    const host = throughWorkflows(operator!, ID, async (binding) => (await op("import", { id: binding })).state);
    const results = await checkHost({
      type: dockerTf.resources.container as unknown as Resource,
      apply: host.apply,
      stop: async () => void (await op("delete", { id: host.binding() })),
      client: company!,
      secrets: Object.values(secrets),
      commit: repo.commit,
      drift: host.drift,
      timeoutMs: 600_000,
    });
    expect(results).toEqual([
      { name: "the app answers on its port", ok: true },
      { name: "a queued run drains", ok: true },
      { name: "LISTEN hears a credential change", ok: true },
      { name: "a sleep survives a restart", ok: true },
      { name: "a new commit shows as drift that apply clears", ok: true },
      { name: "no secret is in the ledger", ok: true },
    ]);
    // The operator's runs (apply and drift) carried the container's environment through the driver only.
    const runs = await operator!.runs({ limit: 1000 });
    const ledgers = JSON.stringify(await Promise.all(runs.map((run) => operator!.ledger(run.runId))));
    for (const value of Object.values(secrets)) expect(ledgers).not.toContain(value);
  }, 1_800_000);
});
