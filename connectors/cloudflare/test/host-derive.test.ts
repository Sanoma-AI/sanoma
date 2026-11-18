import { checkDerivedHost, noSecretIn } from "sanoma/testing/host";
import { type CallContext, memorySecrets } from "sanoma/workflows";
import { secret } from "sanoma/resources";
import { afterAll, describe, expect, it } from "vitest";
import { container, host } from "../src/connector.ts";
import { fakeCloudflare } from "../src/fake.ts";

// `cloudflare.host`: the Worker `cloudflare.container` runs, declared by its decisions alone.

describe("cloudflare.host", () => {
  it("passes the derived-host checks", () => {
    expect(checkDerivedHost(host).filter((check) => !check.ok)).toEqual([]);
  });

  it("is the container's Worker under a new name: a lockfile binding of either binds it", () => {
    expect(host.formerly).toEqual(["cloudflare.container"]);
    expect(container.title).toMatch(/deprecated/);
  });

  it("is declared behind a router by `agents`, a wrong address or a written secret refused in the data file", () => {
    const agents = { url: "https://mcp.acme.example/mcp", company: "acme", secret: secret("ACME_AT_ROUTER") };
    const declared = host({ name: "acme", agents });
    // The secret's name stays in its place; nothing of the address is a reference.
    expect(declared.desired.agents).toEqual(agents);
    // The runtime's own rules (`routedAgentAddress`, `COMPANY_ID`): `sanoma check` says it, not a Worker's log.
    expect(() => host({ name: "acme", agents: { ...agents, url: "https://mcp.acme.example" } })).toThrow(
      /agents\.url[\s\S]*is not a router's agent surface|is not a router's agent surface[\s\S]*agents\.url/,
    );
    expect(() => host({ name: "acme", agents: { ...agents, company: "acme.example" } })).toThrow(
      /letters, digits, - and _ only/,
    );
    // Only the secret is one: the address is written out.
    expect(() => host({ name: "acme", agents: { ...agents, company: secret("COMPANY") as never } })).toThrow(
      /agents\.company is not write-only/,
    );
    // The router's hostname is the config's, which apply fills.
    expect(() => host({ name: "acme", routerHostname: "mcp.acme.example" })).toThrow(/leave out routerHostname/);
  });

  describe("behind a router and serving one, on the fake", () => {
    const fake = fakeCloudflare({ zones: ["acme.example"] });
    afterAll(() => fake.close());
    const values = {
      DB_URL: "postgres://user:never-shown@db.example/company",
      ACME_AT_ROUTER: "0123456789abcdef".repeat(4),
      SANOMA_ROUTER_SECRET: "the-router's-master-secret-0123456789",
    };
    const secrets = memorySecrets(values);
    let n = 0;
    const op = (name: string, input: object) =>
      fake.driver.ops[`host.${name}`]!(input, {
        idempotencyKey: `${name}:${++n}`,
        runId: "router",
        opId: `cloudflare.host.${name}`,
        attempt: 1,
        secrets,
      }) as Promise<{ action?: string; state: Record<string, unknown> }>;
    const base = {
      image: "ghcr.io/sanoma-ai/runtime:0.11.4",
      source: "https://github.com/acme/company.git",
      ref: "main",
      revision: "0".repeat(40),
      secrets: { SANOMA_DATABASE_URL: secret("DB_URL") },
    };
    const bound = (script: string) =>
      Object.fromEntries(fake.state.scripts[script]!.bindings.map((b) => [b.name, b] as const));
    const hostnames = () =>
      Object.values(fake.state.domains)
        .map((d) => d.hostname)
        .toSorted();

    it("binds a routed company's address and its secret, plans nothing after, and unbinds all three once `agents` is left out", async () => {
      const address = { url: "https://mcp.acme.example/mcp", company: "acme" };
      const desired = { ...base, name: "acme", agents: { ...address, secret: secret("ACME_AT_ROUTER") } };
      const plan = await op("plan", { desired });
      const made = await op("create", { desired });
      expect(made.state.agents).toEqual(address);
      expect(bound("sanoma-acme")).toMatchObject({
        SANOMA_AGENT_URL: { type: "plain_text", text: address.url },
        SANOMA_COMPANY: { type: "plain_text", text: "acme" },
        // Its text is the upload's alone (the driver's tests read it there): the account shows a secret's name.
        SANOMA_ROUTER_SECRET: { type: "secret_text" },
      });
      const read = await op("read", { id: "acme" });
      expect(read.state.agents).toEqual(address);
      expect(await op("plan", { id: "acme", desired })).toMatchObject({ action: "none" });
      expect(
        noSecretIn(Object.values(values), {
          plan: JSON.stringify(plan),
          state: JSON.stringify(made),
          read: JSON.stringify(read),
        }),
      ).toMatchObject({ ok: true });
      // Drift compares the address and never the secret, which no state holds.
      const compared = host.normalize(read.state, desired as never);
      expect(compared).toMatchObject({ agents: address });
      expect(compared.agents).not.toHaveProperty("secret");
      const { agents: _agents, ...unrouted } = desired;
      expect(await op("plan", { id: "acme", desired: unrouted })).toMatchObject({ action: "update" });
      const after = await op("update", { id: "acme", desired: unrouted });
      expect(after.state).not.toHaveProperty("agents");
      for (const name of ["SANOMA_AGENT_URL", "SANOMA_COMPANY", "SANOMA_ROUTER_SECRET"]) {
        expect(bound("sanoma-acme")).not.toHaveProperty(name);
      }
      await op("delete", { id: "acme" });
    });

    it("attaches the config's router's hostname beside the app's with the master secret, and detaches it once the config serves none", async () => {
      const hostname = "internal.acme.example";
      const plain = { ...base, name: "router", hostname };
      // As apply gives it for a config with `router: { hostname }` whose master secret is stored.
      const serving = {
        ...plain,
        routerHostname: "mcp.acme.example",
        secrets: { ...base.secrets, SANOMA_ROUTER_SECRET: secret("SANOMA_ROUTER_SECRET") },
      };
      const made = await op("create", { desired: serving });
      expect(made.state).toMatchObject({ hostname, routerHostname: "mcp.acme.example", url: `https://${hostname}` });
      expect(hostnames()).toEqual([hostname, "mcp.acme.example"]);
      expect(bound("sanoma-router")).toMatchObject({
        SANOMA_ROUTER_HOSTNAME: { type: "plain_text", text: "mcp.acme.example" },
        SANOMA_ROUTER_SECRET: { type: "secret_text" },
      });
      expect(noSecretIn(Object.values(values), { state: JSON.stringify(made) })).toMatchObject({ ok: true });
      expect(await op("plan", { id: "router", desired: serving })).toMatchObject({ action: "none" });
      // Detached by hand: drift, which the next update attaches again.
      const id = Object.entries(fake.state.domains).find(([, d]) => d.hostname === "mcp.acme.example")![0];
      delete fake.state.domains[id];
      expect((await op("read", { id: "router" })).state).not.toHaveProperty("routerHostname");
      await op("update", { id: "router", desired: serving });
      expect(hostnames()).toEqual([hostname, "mcp.acme.example"]);
      // The config's `router` taken out: the hostname detached, the secret unbound, the app's own kept.
      const after = await op("update", { id: "router", desired: plain });
      expect(after.state).not.toHaveProperty("routerHostname");
      expect(hostnames()).toEqual([hostname]);
      expect(bound("sanoma-router")).not.toHaveProperty("SANOMA_ROUTER_HOSTNAME");
      expect(bound("sanoma-router")).not.toHaveProperty("SANOMA_ROUTER_SECRET");
      // Attached again, then deleted with the Worker: nothing of Sanoma's is left attached.
      await op("update", { id: "router", desired: serving });
      await op("delete", { id: "router" });
      expect(fake.state.domains).toEqual({});
    });
  });

  describe("on the fake", () => {
    const fake = fakeCloudflare();
    afterAll(() => fake.close());
    const values = { DB_URL: "postgres://user:never-shown@db.example/company", TOKEN: "cf-token-never-shown" };
    let n = 0;
    const call = (opId: string): CallContext => ({
      idempotencyKey: `${opId}:${++n}`,
      runId: "derive",
      opId,
      attempt: 1,
      secrets: memorySecrets(values),
    });
    // As apply calls it: what the data file leaves out filled, the secrets as markers.
    const desired = {
      name: "derived",
      image: "ghcr.io/sanoma-ai/runtime:0.11.4",
      source: "https://github.com/acme/company.git",
      ref: "main",
      revision: "0".repeat(40),
      secrets: { SANOMA_DATABASE_URL: secret("DB_URL"), CLOUDFLARE_API_TOKEN: secret("TOKEN") },
    };

    it("runs on the image's port, with no secret value in its plan or state", async () => {
      const plan = await fake.driver.ops["host.plan"]!({ desired }, call("cloudflare.host.plan"));
      const made = (await fake.driver.ops["host.create"]!({ desired }, call("cloudflare.host.create"))) as {
        state: Record<string, unknown>;
      };
      expect(made.state).toMatchObject({ name: "derived", port: 3000, ref: "main" });
      const read = await fake.driver.ops["host.read"]!({ id: "derived" }, call("cloudflare.host.read"));
      expect(
        noSecretIn(Object.values(values), {
          plan: JSON.stringify(plan),
          state: JSON.stringify(made),
          read: JSON.stringify(read),
        }),
      ).toMatchObject({ ok: true });
    });
  });
});
