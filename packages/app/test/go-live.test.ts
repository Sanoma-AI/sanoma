import { execFileSync } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fakeGithub } from "@sanoma-ai/connector-github/fake";
import { github } from "@sanoma-ai/connector-github";
import { supabase } from "@sanoma-ai/connector-supabase";
import { fakeSupabase } from "@sanoma-ai/connector-supabase/fake";
import { testDatabaseUrl, waitFor, withFake } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { fakeHost } from "@sanoma-ai/testing/host";
import { isEnded, memoryLedger, resolveConfig, type SanomaConfig } from "@sanoma-ai/workflows";
import { describeConfig, readDataFiles, readLockfile, readResources } from "@sanoma-ai/workflows/describe";
import { startWakeupService, type WakeupService } from "@sanoma-ai/workflows/wakeup-service";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Client } from "pg";
import { NodeRequest, sendNodeResponse } from "srvx/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { localGitSource } from "../../sanoma/src/source.ts";
import { type GoLiveProgress, INFRA } from "../src/api.ts";
import type { AppContext } from "../src/context.ts";
import { loopbackLogin } from "../src/loopback.ts";
import { admitting } from "../src/login/admission.ts";
import { goLive, goLiveChoices, goLiveHost, goLiveProgress, renderInfra } from "../src/server/go-live.ts";
import { setSetupToken } from "../src/server/setup.ts";

// Going live end to end, on fakes, from a company with nothing but a first commit: the choices
// (GitHub and Supabase answered by msw), infra.ts written and committed, apply on the repository
// and the database (GitHub's and Supabase's fakes) held for a person, the database URL stored
// after the project is made, the push to a bare repository standing in for GitHub's, and apply on
// a host in this process, which ends answering at its URL, with a wakeup service connected (one
// in this process, on a database of its own): `sanoma.wakeup` declared after the host, which is
// given the instance's token from its first apply, and the repository's deploy key, whose
// private half the host is given to clone with. Needs Postgres.

const databaseUrl = testDatabaseUrl("go_live");
const dir = mkdtempSync(join(tmpdir(), "sanoma-go-live-"));
const root = join(dir, "company");
const remotes = join(dir, "remotes");
const remote = join(remotes, "acme", "acme-ops.git");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

// The company: a first commit, its people and its policy, which holds every change for the lead,
// once per run, as a team would.
mkdirSync(root);
writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "acme-ops", private: true }, null, 2)}\n`);
mkdirSync(join(root, "resources"));
writeFileSync(
  join(root, "resources/people.ts"),
  `import { sanoma } from "sanoma/resources";

export const alice = sanoma.person({ id: "alice" });
export const lead = sanoma.person({ id: "lead" });
`,
);
mkdirSync(join(root, "policies"));
writeFileSync(
  join(root, "policies/changes.cedar"),
  `@hold("lead")
forbid (principal, action in Sanoma::Action::"effect:write", resource);
`,
);
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

/** What the host was started with, each time. */
const started: { port: number; revision: string; secrets: Record<string, string> }[] = [];
const servers: Server[] = [];
const host = fakeHost(async (input) => {
  started.push(input);
  const server = createServer((req, res) => res.writeHead(req.url === "/healthz" ? 200 : 404).end());
  servers.push(server);
  await new Promise<void>((done) => server.listen(input.port, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, stop: () => new Promise<void>((done) => server.close(() => done())) };
});

// A database of its own, made again for each run of the file: a run an earlier one left queued
// would be the latest run, and a credential it stored would not decrypt under this run's key.
beforeAll(async () => {
  const name = new URL(databaseUrl).pathname.slice(1);
  const db = new Client({ connectionString: Object.assign(new URL(databaseUrl), { pathname: "/postgres" }).href });
  await db.connect();
  await db.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await db.end();
});

const githubFake = fakeGithub();
const config: SanomaConfig = {
  workflows: [],
  connectors: [withFake(github, githubFake), withFake(supabase, fakeSupabase()), host.connector],
  ledger: memoryLedger(),
  root,
};
const source = localGitSource(root);
const app = useTestApp(config, { databaseUrl, source });

const api = setupServer(
  http.get("https://api.github.com/user", () => HttpResponse.json({ login: "acme-dev" })),
  http.get("https://api.github.com/user/orgs", () => HttpResponse.json([{ login: "acme" }])),
  http.get("https://api.supabase.com/v1/organizations", () => HttpResponse.json([{ id: "acme-org", name: "Acme" }])),
);

/** The secrets going live stores or reads, which the worker loads into this process's environment. */
const NAMES = [
  "GITHUB_TOKEN",
  "GITHUB_OWNER",
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_DB_PASSWORD",
  "SANOMA_DATABASE_URL_STORE",
  "SANOMA_GITHUB_APP_ID",
  "SANOMA_GITHUB_APP_PEM",
  "SANOMA_WAKEUP_URL",
  "SANOMA_WAKEUP_ACCOUNT_TOKEN",
  "SANOMA_WAKEUP_TOKEN",
  "SANOMA_SOURCE_KEY",
];
const alice = { id: "alice" };
let ctx: AppContext;
let port = 0;
/** The wakeup service, at `wakeup.url`, and an account's token there. */
let wakeup: { url: string; account: string; service: WakeupService; server: Server };

beforeAll(async () => {
  for (const name of NAMES) vi.stubEnv(name, undefined);
  api.listen({ onUnhandledFrame: "bypass" });
  await app.client.setSecret("GITHUB_TOKEN", "ghp_test-token", { by: "alice" });
  await app.client.setSecret("SUPABASE_ACCESS_TOKEN", "sbp_test-token", { by: "alice" });
  ctx = {
    resolved: resolveConfig(app.config),
    description: describeConfig(app.config),
    client: app.client,
    place: "this-computer",
    login: admitting(loopbackLogin(), () => ({ people: [], problems: [] })),
    source,
  };
  // A free port for the host.
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  port = (probe.address() as AddressInfo).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const service = await startWakeupService({
    databaseUrl: testDatabaseUrl("go_live_wakeup"),
    log: { info: () => {}, warn: () => {} },
  });
  const [route] = service.routes;
  const server = createServer((req, res) => {
    void route!.handle(new NodeRequest({ req, res })).then((answer) => sendNodeResponse(res, answer));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  wakeup = { url, account: (await service.mintAccount("go-live")).token, service, server };
});

afterAll(async () => {
  api.close();
  wakeup?.server.closeAllConnections();
  await new Promise<void>((done) => (wakeup ? wakeup.server.close(() => done()) : done()));
  await wakeup?.service.stop();
  await host.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** Progress once the latest run waits on a person, or has ended. */
const settled = () =>
  waitFor(
    () => goLiveProgress(ctx),
    (p) => p.run !== null && (p.run.pending !== undefined || isEnded(p.run.status)),
    60_000,
  );

/** A deploy key's public half, as `renderInfra` takes it. */
const DEPLOY_KEY = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC0deploykey";

/** Approves the run's pending approval as the lead, then waits for the run to end. */
async function approveRun(progress: GoLiveProgress) {
  await app.client.decide(progress.run!.runId, { decision: "approve", by: { id: "lead" } });
  return waitFor(
    () => goLiveProgress(ctx),
    (p) => p.run !== null && isEnded(p.run.status),
    60_000,
  );
}

const choices = () => ({ owner: "acme", name: "acme-ops", organization: "acme-org", region: "eu-west-1", port });

describe("going live", () => {
  it("offers the token's accounts, the database with Supabase's organizations and regions, and the host", async () => {
    expect(await goLiveChoices(ctx)).toMatchObject({
      owners: [
        { login: "acme-dev", kind: "user", via: "token" },
        { login: "acme", kind: "organization", via: "token" },
      ],
      organizations: [{ id: "acme-org", name: "Acme" }],
      database: {
        type: "supabase.project",
        title: "Project",
        regions: expect.arrayContaining(["us-east-1", "eu-west-1"]),
        size: false,
      },
      host: { type: "testhost.app", title: "Test host", publicUrl: false },
      missing: [],
      name: "acme-ops",
      errors: [],
    });
    expect(await goLiveProgress(ctx)).toEqual({
      infra: null,
      bound: { repo: false, deployKey: false, store: false, host: false },
      run: null,
      host: null,
    });
  });

  it("writes infra.ts as a data file the config reads: the repository, the database, and a host running them", async () => {
    const text = await renderInfra(ctx, choices(), DEPLOY_KEY);
    expect(text).toBe(
      [
        `import { github } from "@sanoma-ai/connector-github/resources";`,
        `import { supabase } from "@sanoma-ai/connector-supabase/resources";`,
        `import { testhost } from "@sanoma-ai/testing-host/resources";`,
        `import { secret } from "sanoma/resources";`,
        ``,
        `export const repo = github.repository({`,
        `  name: "acme-ops",`,
        `  visibility: "private",`,
        `});`,
        ``,
        `export const deployKey = github.repository_deploy_key({`,
        `  repository: repo,`,
        `  title: "Sanoma host",`,
        `  key: "${DEPLOY_KEY}",`,
        `  read_only: true,`,
        `});`,
        ``,
        `export const store = supabase.project({`,
        `  name: "acme-ops",`,
        `  region: "eu-west-1",`,
        `  organization_id: "acme-org",`,
        `  database_password: secret("SUPABASE_DB_PASSWORD", { generate: true }),`,
        `});`,
        ``,
        `export const host = testhost.app({`,
        `  name: "acme-ops",`,
        `  source: repo,`,
        `  ref: "main",`,
        `  secrets: {`,
        `    SANOMA_DATABASE_URL: secret("SANOMA_DATABASE_URL_STORE"),`,
        `    SANOMA_SECRETS_KEY: secret("SANOMA_SECRETS_KEY"),`,
        `    SANOMA_SOURCE_KEY: secret("SANOMA_SOURCE_KEY"),`,
        `  },`,
        `  port: ${port},`,
        `});`,
        ``,
        `export default [repo, deployKey, store, host];`,
        ``,
      ].join("\n"),
    );
    // Read back as the worker reads it, in a directory of its own: four resources, no problems.
    const other = mkdtempSync(join(tmpdir(), "sanoma-go-live-read-"));
    try {
      mkdirSync(join(other, "resources", "sanoma"), { recursive: true });
      writeFileSync(join(other, INFRA), text);
      const read = readDataFiles(other, config.connectors);
      expect(read.problems).toEqual([]);
      expect(read.resources.map((r) => [r.id, `${r.vendor}.${r.type}`, r.refs])).toEqual([
        [`${INFRA}#repo`, "github.repository", {}],
        [`${INFRA}#deployKey`, "github.repository_deploy_key", { repository: `${INFRA}#repo` }],
        [`${INFRA}#store`, "supabase.project", {}],
        [`${INFRA}#host`, "testhost.app", { source: `${INFRA}#repo` }],
      ]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("declares sanoma.wakeup after the host once a wakeup service is connected, the host given the instance's token", async () => {
    await setSetupToken(ctx, alice, { name: "SANOMA_WAKEUP_ACCOUNT_TOKEN", value: wakeup.account });
    await setSetupToken(ctx, alice, { name: "SANOMA_WAKEUP_URL", value: wakeup.url });
    const text = await renderInfra(ctx, choices(), DEPLOY_KEY);
    expect(text).toContain(`import { sanoma, secret } from "sanoma/resources";`);
    // The worker on the host registers with the instance's token, at the service's URL.
    expect(text).toContain(
      `    SANOMA_WAKEUP_TOKEN: secret("SANOMA_WAKEUP_TOKEN"),\n    SANOMA_WAKEUP_URL: secret("SANOMA_WAKEUP_URL"),\n`,
    );
    expect(text).toContain(`export const wakeup = sanoma.wakeup({\n  host: host,\n});\n`);
    expect(text).toContain(`export default [repo, deployKey, store, host, wakeup];`);
    const other = mkdtempSync(join(tmpdir(), "sanoma-go-live-read-"));
    try {
      mkdirSync(join(other, "resources", "sanoma"), { recursive: true });
      writeFileSync(join(other, INFRA), text);
      // Read against the config's connectors and the built-in wakeup.
      const read = readResources({ ...config, root: other });
      expect(read.map((r) => [r.id, `${r.vendor}.${r.type}`, r.refs])).toEqual([
        [`${INFRA}#repo`, "github.repository", {}],
        [`${INFRA}#deployKey`, "github.repository_deploy_key", { repository: `${INFRA}#repo` }],
        [`${INFRA}#store`, "supabase.project", {}],
        [`${INFRA}#host`, "testhost.app", { source: `${INFRA}#repo` }],
        [`${INFRA}#wakeup`, "sanoma.wakeup", { host: `${INFRA}#host` }],
      ]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("refuses a push before the repository and the database are made", async () => {
    await expect(goLiveHost(ctx, alice)).rejects.toMatchObject({ status: 409 });
  });

  it("goes from the choices to a host answering at its URL", async () => {
    // Steps 3 and 4: infra.ts committed, the owner stored, apply on the repository, its deploy key and the database.
    await goLive(ctx, alice, choices());
    const sourceKey = (await app.client.secrets(["SANOMA_SOURCE_KEY"])).get("SANOMA_SOURCE_KEY")!.value;
    expect(sourceKey).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n/);
    expect(readFileSync(join(root, INFRA), "utf8")).toMatch(/\n {2}key: "ssh-rsa [A-Za-z0-9+/]+=*",\n/);
    expect(git("log", "-1", "--format=%an|%s", "--", INFRA)).toBe(
      "alice via Sanoma|Go live: declare the repository, its deploy key, the database and the host",
    );
    expect((await app.client.secrets(["GITHUB_OWNER"])).get("GITHUB_OWNER")?.value).toBe("acme");
    let progress = await settled();
    expect(progress.infra).toBe(readFileSync(join(root, INFRA), "utf8"));
    expect(progress.run).toMatchObject({ status: "waiting", pending: { plan: { problems: [] } } });
    expect(progress.run!.pending!.plan!.steps.map((s) => [s.id, s.action])).toEqual([
      [`${INFRA}#repo`, "create"],
      [`${INFRA}#deployKey`, "create"],
      [`${INFRA}#store`, "create"],
    ]);
    // Going live writes the file once.
    await expect(goLive(ctx, alice, choices())).rejects.toBeTruthy();

    progress = await approveRun(progress);
    expect(progress.run!.results).toMatchObject([
      { id: `${INFRA}#repo`, status: "done" },
      { id: `${INFRA}#deployKey`, status: "done" },
      { id: `${INFRA}#store`, status: "done" },
    ]);
    expect(progress.bound).toEqual({ repo: true, deployKey: true, store: true, host: false });
    // The project's afterCreate stored its database URL, through its session pooler.
    const url = (await app.client.secrets(["SANOMA_DATABASE_URL_STORE"])).get("SANOMA_DATABASE_URL_STORE")?.value;
    expect(url).toMatch(/^postgresql:\/\/postgres\.[\w-]+:.+@aws-0-eu-west-1\.pooler\.supabase\.com:5432\/postgres/);

    // What GitHub would hold now: the repository, empty, by its node id, with its clone URL.
    const { bindings } = readLockfile(root);
    githubFake.put("repository", bindings[`${INFRA}#repo`]!.id, {
      name: "acme-ops",
      node_id: bindings[`${INFRA}#repo`]!.id,
      visibility: "private",
      http_clone_url: "https://github.com/acme/acme-ops.git",
    });
    execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);

    // Steps 5 and 6: the push, then apply on the host.
    await goLiveHost(ctx, alice);
    const head = git("rev-parse", "main");
    expect(execFileSync("git", ["rev-parse", "main"], { cwd: remote, encoding: "utf8" }).trim()).toBe(head);
    progress = await settled();
    // One apply, the wakeup after the host it names.
    expect(progress.run!.pending!.plan!.steps.map((s) => [s.id, s.action])).toEqual([
      [`${INFRA}#host`, "create"],
      [`${INFRA}#wakeup`, "create"],
    ]);
    progress = await approveRun(progress);
    // The wakeup's create needs the host's URL in its `host`, which apply fills from the host's
    // state once #337 lands; until then it is given the host's binding, which the service refuses.
    expect(progress.run!.results![0]).toMatchObject({ id: `${INFRA}#host`, status: "done" });
    expect(progress.bound.host).toBe(true);
    expect(progress.host).toEqual({ url: `http://127.0.0.1:${port}`, healthy: true });
    // The host runs main as pushed, given the database URL, the key, the deploy key's private half
    // and the wakeup's instance token, minted when the wakeup service was connected, none of which
    // any ledger record holds.
    const token = (await app.client.secrets(["SANOMA_WAKEUP_TOKEN"])).get("SANOMA_WAKEUP_TOKEN")!.value;
    expect(token).toMatch(/^swi_/);
    expect(started).toEqual([
      {
        port,
        revision: head,
        secrets: {
          SANOMA_DATABASE_URL: url,
          SANOMA_SECRETS_KEY: process.env.SANOMA_SECRETS_KEY,
          SANOMA_SOURCE_KEY: sourceKey,
          SANOMA_WAKEUP_TOKEN: token,
          SANOMA_WAKEUP_URL: wakeup.url,
        },
      },
    ]);
    const runs = await app.client.runs({ limit: 10 });
    const ledgers = JSON.stringify(await Promise.all(runs.map((r) => app.client.ledger(r.runId))));
    expect(ledgers).not.toContain(url);
    expect(ledgers).not.toContain(process.env.SANOMA_SECRETS_KEY);
    expect(ledgers).not.toContain(token);
    expect(ledgers).not.toContain("PRIVATE KEY");
  });

  it("deletes the wakeup's instance at the service once its line is removed and the orphan answered delete", async () => {
    const key = `${INFRA}#wakeup`;
    // An instance at the service for the host, bound to the declaration (as its create binds it).
    const account = { authorization: `Bearer ${wakeup.account}` };
    const instance = `swi_${"b".repeat(43)}`;
    const posted = await fetch(`${wakeup.url}/wakeup/instances`, {
      method: "POST",
      headers: { ...account, "content-type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${port}`, token: instance }),
    });
    const { id } = (await posted.json()) as { id: string };
    // Waits for the run to end, not just the binding: its commit of the lockfile follows.
    const binding = await app.client.apply({ only: [key], bind: { [key]: id } }, { startedBy: alice });
    await app.client.result(binding, 60_000);
    expect(readLockfile(root).bindings[key]?.id).toBe(id);
    // The line removed (the import and the default export's entry with it), as a person would.
    const path = join(root, INFRA);
    writeFileSync(
      path,
      readFileSync(path, "utf8")
        .replace(`import { sanoma, secret } from "sanoma/resources";`, `import { secret } from "sanoma/resources";`)
        .replace(`export const wakeup = sanoma.wakeup({\n  host: host,\n});\n\n`, "")
        .replace("[repo, deployKey, store, host, wakeup]", "[repo, deployKey, store, host]"),
    );
    git("commit", "--quiet", "-am", "Remove the wakeup");
    await app.client.apply({ only: [key], answers: { [key]: "delete" } }, { startedBy: alice });
    let progress = await settled();
    expect(progress.run!.pending!.plan!.steps).toMatchObject([{ id: key, action: "orphan", answer: "delete" }]);
    progress = await approveRun(progress);
    expect(progress.run!.results).toMatchObject([{ id: key, status: "done" }]);
    expect((await fetch(`${wakeup.url}/wakeup/instances/${id}`, { headers: account })).status).toBe(404);
    expect(readLockfile(root).bindings[key]).toBeUndefined();
  });

  it("lists the App's installations, signed as the App, and says which list it could not read", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signedBy: string[] = [];
    api.use(
      http.get("https://api.github.com/app/installations", ({ request }) => {
        const [head, body, signature] = request.headers.get("authorization")!.replace("Bearer ", "").split(".");
        const verified = createVerify("RSA-SHA256")
          .update(`${head}.${body}`)
          .verify(publicKey, signature!, "base64url");
        signedBy.push(verified ? JSON.parse(Buffer.from(body!, "base64url").toString()).iss : "nobody");
        return HttpResponse.json([{ id: 7, account: { login: "acme-labs", type: "Organization" } }]);
      }),
      http.get("https://api.supabase.com/v1/organizations", () => HttpResponse.json({}, { status: 401 })),
    );
    await app.client.setSecret("SANOMA_GITHUB_APP_ID", "4242", { by: "alice" });
    await app.client.setSecret(
      "SANOMA_GITHUB_APP_PEM",
      privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      {
        by: "alice",
      },
    );
    // No token of the person's own: the fakes' drivers declare no variables to clear it by.
    const db = new Client({ connectionString: databaseUrl });
    await db.connect();
    await db.query("DELETE FROM sanoma_credentials WHERE name = 'GITHUB_TOKEN'");
    await db.end();
    const { owners, organizations, errors } = await goLiveChoices(ctx);
    expect(owners).toEqual([{ login: "acme-labs", kind: "organization", via: "app" }]);
    expect(signedBy).toEqual(["4242"]);
    expect(organizations).toEqual([]);
    expect(errors).toEqual(["Supabase's organizations: api.supabase.com answered 401 to /v1/organizations"]);
  });
});
