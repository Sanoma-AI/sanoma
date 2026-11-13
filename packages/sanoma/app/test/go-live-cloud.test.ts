import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cloud } from "@sanoma-ai/connector-sanoma-cloud";
import { fakeCloud } from "@sanoma-ai/connector-sanoma-cloud/fake";
import { testDatabaseUrl, withFake } from "sanoma/testing";
import { useTestApp } from "sanoma/testing/harness";
import { DriverError, memoryLedger, resolveConfig, type SanomaConfig } from "sanoma/workflows";
import { readLockfile } from "sanoma/workflows/describe";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { localGitSource } from "../../src/source.ts";
import { INFRA } from "../src/api.ts";
import type { AppContext } from "../src/context.ts";
import { loopbackLogin } from "../src/loopback.ts";
import { admitting } from "../src/login/admission.ts";
import { companyState } from "../src/server/company-state.ts";
import { cloudAddress, goLiveProgress, goLiveSignIn } from "../src/server/go-live.ts";
import { liveSnapshot } from "../src/snapshot-build.ts";
import { pushCloud } from "../src/steps/go-live-cloud.ts";
import { appSteps } from "../src/steps/index.ts";
import { pageApi } from "./page-api.ts";

// Going live on Sanoma Cloud end to end, on the Cloud's fake, from a company the template made
// (`infra.ts` declaring the Cloud's database and host, named `acme`) with nothing but a first
// commit: the built-in `go-live-cloud` on a worker given the app's steps, called as Hosting calls
// it. Refused without a Cloud token; the address checked at the Cloud; a new address written and
// committed; the repository made in the Cloud's account through the run's `ctx` (a bare
// repository here stands in for GitHub's), `origin` set to it and `main` pushed; the database and
// the host applied, a host that does not start failing the run, Retry going live. Needs Postgres.

const databaseUrl = testDatabaseUrl("go_live_cloud");
const dir = mkdtempSync(join(tmpdir(), "sanoma-go-live-cloud-"));
const root = join(dir, "company");
const remotes = join(dir, "remotes");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const TEMPLATE = new URL("../../template/resources/sanoma/infra.ts", import.meta.url);

mkdirSync(join(root, "resources", "sanoma"), { recursive: true });
writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "acme-ops", private: true }, null, 2)}\n`);
writeFileSync(
  join(root, "resources/people.ts"),
  `import { sanoma } from "sanoma/resources";\n\nexport const alice = sanoma.person({ id: "alice", email: "alice@acme.test" });\n`,
);
writeFileSync(join(root, INFRA), readFileSync(TEMPLATE, "utf8").replaceAll("company", "acme"));
// Every git here signs as the test, and reaches GitHub's URLs in the bare repositories under `remotes`.
const gitConfig = join(dir, "gitconfig");
writeFileSync(
  gitConfig,
  `[user]\n\tname = Test\n\temail = test@sanoma.invalid\n[url "${pathToFileURL(remotes).href}/"]\n\tinsteadOf = https://github.com/\n`,
);
vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfig);
git("init", "--quiet", "--initial-branch=main");
git("add", "--all");
git("commit", "--quiet", "-m", "First");

const fake = fakeCloud({ owner: "sanoma-test", taken: ["taken"] });

// A database of its own, made again for each run of the file: a run an earlier one left would be the latest.
beforeAll(async () => {
  const name = new URL(databaseUrl).pathname.slice(1);
  const db = new Client({ connectionString: Object.assign(new URL(databaseUrl), { pathname: "/postgres" }).href });
  await db.connect();
  await db.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await db.end();
});

const config: SanomaConfig = {
  secrets: {
    bindings: {
      SANOMA_SECRETS_KEY: { bootstrap: "SANOMA_SECRETS_KEY" },
      SANOMA_SIGNING_KEY: { bootstrap: "SANOMA_SIGNING_KEY" },
    },
  },
  workflows: [],
  connectors: [withFake(cloud, fake)],
  ledger: memoryLedger(),
  root,
};
const source = localGitSource(root);
const app = useTestApp(config, { databaseUrl, source, app: appSteps });
const alice = { id: "alice" };
const TOKEN = "sca_SENTINEL-cloud-token";
let ctx: AppContext;
/** The context as a request reads it: the snapshot of the files as they are now. */
let now: () => Promise<AppContext>;

beforeAll(async () => {
  vi.stubEnv("SANOMA_CLOUD_TOKEN", undefined);
  const live = await liveSnapshot(app.config, { source });
  ctx = {
    resolved: resolveConfig(app.config),
    snapshot: await live(),
    client: app.client,
    place: "this-computer",
    login: admitting(loopbackLogin(), () => ({ people: [], problems: [] })),
  };
  now = async () => ({ ...ctx, snapshot: await live() });
});

afterAll(async () => {
  await fake.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** Goes live on Sanoma Cloud as Hosting does, and waits for the run to end: its output, or the API's refusal. */
const goLive = async (input: { address?: string }) => pageApi(await now(), alice).goLiveCloud(input);

describe("going live on Sanoma Cloud", () => {
  it("is ready on the template's file, which going live on the company's own accounts writes again", async () => {
    expect(await goLiveProgress(await now())).toMatchObject({ infra: null, replaces: true, run: null });
    expect((await companyState(await now())).state).toBe("local");
  });

  it("refuses to go live before a Cloud token is stored, and makes nothing", async () => {
    await expect(goLive({})).rejects.toMatchObject({
      body: { error: expect.stringContaining("Sign in to Sanoma first, on Hosting, or paste a Cloud token there") },
    });
    expect(fake.state.companies).toEqual({});
    expect(git("remote")).toBe("");
    expect(git("log", "-1", "--format=%s")).toBe("First");
    // A run that failed before its apply is what Hosting shows: Go live failed, and why.
    expect(await companyState(await now())).toMatchObject({
      state: "failed",
      run: { workflow: "go-live-cloud", status: "failed" },
    });
  });

  it("checks an address at the Cloud: free, the account's own, or someone else's", async () => {
    await app.client.setSecret("SANOMA_CLOUD_TOKEN", TOKEN, { by: "alice" });
    expect(await cloudAddress(await now(), alice, "acme-co")).toEqual({ slug: "acme-co", status: "available" });
    expect(await cloudAddress(await now(), alice, "taken")).toEqual({ slug: "taken", status: "taken" });
  });

  it("writes a new address, makes and pushes to the repository, and fails when the host does not start", async () => {
    execFileSync("git", [
      "init",
      "--quiet",
      "--bare",
      "--initial-branch=main",
      join(remotes, "sanoma-test", "acme-co.git"),
    ]);
    // The Cloud fails to start the host, once.
    fake.failNext("cloud.host.create", new DriverError("Sanoma Cloud: the host did not start", { retryable: false }));
    await expect(goLive({ address: "acme-co" })).rejects.toMatchObject({
      body: { error: expect.stringContaining("Apply did not finish") },
    });
    // The address written in the file and committed, as the person who went live.
    const infra = readFileSync(join(root, INFRA), "utf8");
    expect(infra).toContain('cloud.database({ name: "acme-co" })');
    expect(infra).toContain('name: "acme-co"');
    expect(infra).toContain('hostname: "acme-co.sanoma.work"');
    expect(git("log", "-1", "--format=%an|%s", "--", INFRA)).toBe("alice via Sanoma|Go live at acme-co.sanoma.work");
    // The repository the Cloud's account made, `origin`, and `main` there.
    expect(git("config", "remote.origin.url")).toBe("https://github.com/sanoma-test/acme-co.git");
    expect(fake.state.companies["acme-co"]?.repository).toMatchObject({ owner: "sanoma-test", name: "acme-co" });
    // The database made and bound; the host not.
    const { bindings } = readLockfile(root);
    expect(bindings[`${INFRA}#store`]).toMatchObject({ type: "cloud.database", id: "acme-co" });
    expect(bindings[`${INFRA}#host`]).toBeUndefined();
    const state = await companyState(await now());
    expect(state).toMatchObject({ state: "failed", run: { workflow: "go-live-cloud", status: "failed" } });
    expect(state.run?.error).toContain("did not start");
    // Its address cannot change now that its database is made.
    await expect(goLive({ address: "acme-two" })).rejects.toMatchObject({
      body: { error: expect.stringContaining("its address cannot change now") },
    });
  });

  it("goes live on Retry: the host made at its address, the run's repository call in the ledger, never the token", async () => {
    const { runId } = (await goLive({})) as { runId: string };
    expect(runId).toMatch(/:apply$/);
    const head = git("rev-parse", "main");
    const pushed = execFileSync("git", ["rev-parse", "main"], {
      cwd: join(remotes, "sanoma-test", "acme-co.git"),
      encoding: "utf8",
    }).trim();
    // What apply committed after the push is the checkout's; what went live is on the remote.
    expect(git("merge-base", "--is-ancestor", pushed, head)).toBe("");
    const { bindings } = readLockfile(root);
    expect(bindings[`${INFRA}#host`]).toMatchObject({ type: "cloud.host", id: "acme-co" });
    expect(fake.state.companies["acme-co"]).toMatchObject({ database: {}, host: {}, repository: {} });
    const state = await companyState(await now());
    expect(state.state).toBe("live");
    expect((await goLiveProgress(await now())).replaces).toBe(false);

    // Every run's records, the repository's call among them, hold no Cloud token.
    const runs = await app.client.runs({ limit: 20 });
    const records = (await Promise.all(runs.map((r) => app.client.ledger(r.runId)))).flat();
    expect(records.some((r) => r.type === "op.called" && r.op === "cloud.company.repository")).toBe(true);
    expect(JSON.stringify(records)).not.toContain(TOKEN);
    expect(JSON.stringify(runs)).not.toContain(TOKEN);
  });

  it("signs a person in on the host with a link the Cloud's account mints", async () => {
    const { url } = await goLiveSignIn(await now(), alice);
    expect(url).toMatch(/\/auth\/invite\/fake-\d+-alice@acme\.test$/);
  });

  it("refuses to go live again, on Sanoma Cloud or on the company's own accounts", async () => {
    await expect(goLive({})).rejects.toMatchObject({
      body: { error: expect.stringContaining("The host is made already: the company is live") },
    });
    const choices = { owner: "acme", name: "acme-ops", region: "us-east-1", port: 3000 };
    await expect(pageApi(await now(), alice).goLive(choices)).rejects.toMatchObject({
      body: { error: `${INFRA} is written already: change it in the file, and apply from Hosting` },
    });
  });

  it("pushes to no repository whose owner or name is not GitHub's, before touching the checkout", async () => {
    const serially = vi.fn<() => Promise<void>>();
    const step = { source: { pushOrigin: vi.fn<() => Promise<void>>() }, serially } as unknown as Parameters<
      typeof pushCloud
    >[0];
    for (const repository of [
      { owner: "evil/x", name: "ops" },
      { owner: "acme", name: ".." },
      { owner: "acme", name: "ops#x" },
    ]) {
      await expect(pushCloud(step, { repository })).rejects.toThrow("is no GitHub owner/name");
    }
    expect(serially).not.toHaveBeenCalled();
  });
});
