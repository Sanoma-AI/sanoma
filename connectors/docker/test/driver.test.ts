import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { dockerAvailable } from "@sanoma-ai/testing/host";
import { type Driver, memorySecrets } from "@sanoma-ai/workflows";
import { secret } from "@sanoma-ai/workflows/resources";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeBridge } from "../../../packages/bridge/test/fake-bridge.ts";
import { containerType, dockerTf } from "../src/connector.ts";
import { dockerDriver, dockerHost, type Inspected, inspectContainer, observed } from "../src/driver.ts";
import { fakeDocker } from "../src/fake.ts";

let seq = 0;
const call = (driver: Driver, op: string, input: unknown): Promise<any> =>
  driver.ops[op]!(input, {
    idempotencyKey: `run:${++seq}`,
    runId: "run",
    opId: `docker.${op}`,
    attempt: 1,
    secrets: memorySecrets({ HOST_KEY: SECRET }),
  });

/** Made up: what no output may hold. */
const SECRET = "docker-test-secret-value";
const NAME = "sanoma-test-driver";
/** A container image that answers `/healthz` (any path) on port 3000, built by the live test. */
const IMAGE = "sanoma-test-healthz:dev";
const desired = {
  name: NAME,
  image: IMAGE,
  source: "git://example.invalid/company.git",
  ref: "main",
  revision: "1111111111111111111111111111111111111111",
  port: 18_557,
  secrets: { SANOMA_SECRETS_KEY: secret("HOST_KEY") },
};
const container = dockerTf.resources.container;

describe("docker.container", () => {
  it("is a writable host, its secrets and the provider's env write-only", () => {
    expect(container.writable).toBe(true);
    expect(container.stateless).toBe(true);
    expect(container.fields.writeOnly).toEqual(["secrets"]);
    expect(container.host?.outputs({ port: 18_557, revision: "abc", running: true })).toEqual({
      url: "http://127.0.0.1:18557",
      revision: "abc",
      healthy: true,
    });
    const { revision: _, ...declared } = desired;
    expect(container(declared).desired.secrets).toEqual({ SANOMA_SECRETS_KEY: secret("HOST_KEY") });
    expect(() => container({ ...declared, image: "sanoma-runtime:latest" })).toThrow(/not `latest`/);
    expect(() => container({ ...declared, image: "sanoma-runtime" })).toThrow(/pin the image/);
    expect(() => container(desired)).toThrow(/leave out revision: apply sets it from ref/);
  });

  it("gives the runtime a public site's domains in SANOMA_DOMAINS, sorted by site, and reads them back from its label", () => {
    const { secrets: _, ...plain } = desired;
    const domains = { www: "sanoma.example", docs: "docs.sanoma.example" };
    const state = containerType.toProvider({ ...plain, domains });
    const served = "docs=docs.sanoma.example,www=sanoma.example";
    expect(state.env).toContain(`SANOMA_DOMAINS=${served}`);
    expect(state.labels).toContainEqual({ label: "sanoma.domains", value: served });
    expect(state.labels).toContainEqual({
      label: "sanoma.env",
      value: "PORT,SANOMA_DOMAINS,SANOMA_REVISION,SANOMA_SOURCE",
    });
    expect(containerType.fromProvider(state)).toMatchObject({
      domains: { docs: "docs.sanoma.example", www: "sanoma.example" },
    });
    // None, or an empty map: no variable, no label, nothing read back.
    for (const none of [{}, { domains: {} }, { domains: null }]) {
      const without = containerType.toProvider({ ...plain, ...none });
      expect(JSON.stringify(without)).not.toContain("DOMAINS");
      expect(JSON.stringify(without)).not.toContain("sanoma.domains");
      expect(containerType.fromProvider(without)).not.toHaveProperty("domains");
    }
    const { revision: __, ...declared } = desired;
    expect(container({ ...declared, domains }).desired.domains).toEqual(domains);
    const wrong: Record<string, string>[] = [
      { Www: "sanoma.example" },
      { www: "https://sanoma.example" },
      { www: "localhost" },
      {},
    ];
    for (const refused of wrong) {
      expect(() => container({ ...declared, domains: refused }), JSON.stringify(refused)).toThrow(/domains/);
    }
    expect(container.host?.inputs.domains).toBe("domains");
  });

  it("keeps from Docker's inspect the env its label names, its sanoma labels and its ports", () => {
    const inspected: Inspected = {
      Id: "c0ffee",
      Config: {
        Env: ["PATH=/usr/bin", "PORT=3000", "A=1=2", "B=x"],
        Labels: { "sanoma.env": "A,PORT", "sanoma.revision": "abc", "org.opencontainers.image.title": "runtime" },
      },
      HostConfig: { PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "18557" }] } },
      State: { Running: true },
    };
    expect(observed({ id: "c0ffee", env: null, labels: [] }, inspected)).toMatchObject({
      id: "c0ffee",
      must_run: true,
      wait: true,
      env: ["PORT=3000", "A=1=2"],
      labels: [
        { label: "sanoma.env", value: "A,PORT" },
        { label: "sanoma.revision", value: "abc" },
      ],
      ports: [{ internal: 3000, external: 18_557, ip: "127.0.0.1", protocol: "tcp" }],
    });
  });

  it("finds the daemon in DOCKER_HOST, the active context, Docker Desktop's socket, or /var/run", () => {
    const home = mkdtempSync(join(tmpdir(), "sanoma-docker-home-"));
    try {
      expect(dockerHost({ DOCKER_HOST: "tcp://10.0.0.1:2375" }, home)).toBe("tcp://10.0.0.1:2375");
      expect(dockerHost({}, home)).toBe("unix:///var/run/docker.sock");
      mkdirSync(join(home, ".docker", "run"), { recursive: true });
      writeFileSync(join(home, ".docker", "run", "docker.sock"), "");
      expect(dockerHost({}, home)).toBe(`unix://${join(home, ".docker", "run", "docker.sock")}`);
      const meta = join(home, ".docker", "contexts", "meta", createHash("sha256").update("colima").digest("hex"));
      mkdirSync(meta, { recursive: true });
      writeFileSync(
        join(meta, "meta.json"),
        JSON.stringify({ Endpoints: { docker: { Host: "unix:///colima.sock" } } }),
      );
      writeFileSync(join(home, ".docker", "config.json"), JSON.stringify({ currentContext: "colima" }));
      expect(dockerHost({}, home)).toBe("unix:///colima.sock");
      expect(dockerHost({ DOCKER_CONTEXT: "default" }, home)).toBe(
        `unix://${join(home, ".docker", "run", "docker.sock")}`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Recorded against local Docker with SANOMA_LIVE=1 SANOMA_RECORD=1 (and SANOMA_BRIDGE_BIN): the
// bridge's replies in `@sanoma-ai/bridge`'s testdata/replies/kreuzwerker_docker_4.6.0/, Docker's
// inspect answers in fixtures/inspect.json. Live, the test builds its image first.
const live = process.env.SANOMA_LIVE === "1";
const answers = new URL("./fixtures/inspect.json", import.meta.url);
describe.skipIf(live && !dockerAvailable())("dockerDriver over recorded replies", () => {
  const seen: Record<string, Inspected | undefined> = live
    ? {}
    : (JSON.parse(readFileSync(answers, "utf8")) as Record<string, Inspected>);
  const driver = dockerDriver({
    bridge: fakeBridge(),
    host: live ? dockerHost() : "unix:///docker.sock",
    inspect: live ? async (_, id) => (seen[id] = await inspectContainer(dockerHost(), id)) : async (_, id) => seen[id],
  });

  beforeAll(() => {
    if (!live) return;
    const dockerfile = `FROM node:26-bookworm-slim\nCMD ["node", "-e", "require('http').createServer((q, s) => s.end('ok')).listen(3000)"]\n`;
    execFileSync("docker", ["build", "-q", "-t", IMAGE, "-"], {
      input: dockerfile,
      stdio: ["pipe", "ignore", "inherit"],
    });
  }, 300_000);

  afterAll(() => {
    if (live && process.env.SANOMA_RECORD === "1") writeFileSync(answers, `${JSON.stringify(seen, null, 2)}\n`);
  });

  it("creates a container, finds it by name, plans no change, replaces it for a new revision, and deletes it", async () => {
    const plan = await call(driver, "container.plan", { desired });
    expect(plan).toMatchObject({ action: "create", planned: { name: NAME, revision: desired.revision }, replace: [] });

    const created = await call(driver, "container.create", { desired });
    expect(created.state).toMatchObject({ name: NAME, revision: desired.revision, port: 18_557, running: true });
    const found = await call(driver, "container.import", { id: NAME });
    expect(found).toMatchObject({
      id: NAME,
      gone: false,
      state: { id: created.id, source: desired.source, ref: "main" },
    });
    expect(await call(driver, "container.plan", { id: created.id, desired })).toMatchObject({ action: "none" });

    const next = { ...desired, revision: "2222222222222222222222222222222222222222" };
    const replanned = await call(driver, "container.plan", { id: created.id, desired: next });
    expect(replanned).toMatchObject({ action: "replace" });
    expect(replanned.replace).toEqual(expect.arrayContaining(["env", "labels"]));
    const updated = await call(driver, "container.update", {
      id: created.id,
      desired: next,
      expect: { action: "replace", replace: replanned.replace },
    });
    expect(updated.id).not.toBe(created.id);
    expect(updated.state).toMatchObject({ revision: next.revision, running: true });

    expect(await call(driver, "container.delete", { id: updated.id })).toEqual({ id: updated.id, gone: true });
    expect(await call(driver, "container.import", { id: updated.id })).toEqual({ id: updated.id, gone: true });
    for (const out of [plan, created, found, replanned, updated]) expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});

describe("fakeDocker", () => {
  it("creates, reads, replaces and deletes containers in memory", async () => {
    const { driver } = fakeDocker();
    const created = await call(driver, "container.create", { desired });
    expect(created.state).toMatchObject({ name: NAME, revision: desired.revision, running: true });
    expect(await call(driver, "container.plan", { id: created.id, desired })).toMatchObject({ action: "none" });
    const next = { ...desired, revision: "2222222222222222222222222222222222222222" };
    expect(await call(driver, "container.plan", { id: created.id, desired: next })).toMatchObject({
      action: "replace",
    });
    const updated = await call(driver, "container.update", { id: created.id, desired: next });
    expect(updated.state).toMatchObject({ revision: next.revision });
    expect(JSON.stringify(updated)).not.toContain(SECRET);
    expect(await call(driver, "container.delete", { id: updated.id })).toEqual({ id: updated.id, gone: true });
  });
});
