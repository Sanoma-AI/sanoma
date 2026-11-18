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

  it("is declared behind a router by `agents`, a wrong address, a secret or the router's hostname refused in the data file", () => {
    const agents = { url: "https://mcp.acme.example/mcp", company: "acme" };
    expect(host({ name: "acme", agents }).desired.agents).toEqual(agents);
    // The runtime's own rules (`routedAgentsSchema`): `sanoma check` says it, not a Worker's log.
    expect(() => host({ name: "acme", agents: { ...agents, url: "https://mcp.acme.example" } })).toThrow(
      /is not a router's agent surface/,
    );
    expect(() => host({ name: "acme", agents: { ...agents, company: "acme.example" } })).toThrow(
      /is no company's id at a router: letters, digits, - and _ only/,
    );
    // Its secret is no field: the stored SANOMA_ROUTER_SECRET, which apply gives the host.
    expect(() => host({ name: "acme", agents: { ...agents, secret: secret("ACME_AT_ROUTER") } as never })).toThrow(
      /agents\.secret is not write-only/,
    );
    // The router's hostname is the config's, which apply fills.
    expect(() => host({ name: "acme", routerHostname: "mcp.acme.example" })).toThrow(/leave out routerHostname/);
  });

  describe("on the fake", () => {
    const fake = fakeCloudflare({ zones: ["acme.example"] });
    afterAll(() => fake.close());
    const values = {
      DB_URL: "postgres://user:never-shown@db.example/company",
      TOKEN: "cf-token-never-shown",
      // This company's own secret at a router, or the master of the one it serves: the one stored name.
      SANOMA_ROUTER_SECRET: "the-router-secret-0123456789abcdef",
    };
    const secrets = memorySecrets(values);
    let n = 0;
    const op = (name: string, input: object) =>
      fake.driver.ops[`host.${name}`]!(input, {
        idempotencyKey: `${name}:${++n}`,
        runId: "derive",
        opId: `cloudflare.host.${name}`,
        attempt: 1,
        secrets,
      } satisfies CallContext) as Promise<{ action?: string; state: Record<string, unknown> }>;
    // As apply calls it: what the data file leaves out filled, the secrets as markers.
    const base = {
      image: "ghcr.io/sanoma-ai/runtime:0.11.4",
      source: "https://github.com/acme/company.git",
      ref: "main",
      revision: "0".repeat(40),
      secrets: { SANOMA_DATABASE_URL: secret("DB_URL"), CLOUDFLARE_API_TOKEN: secret("TOKEN") },
    };
    /** `base` with the router's secret, as apply gives it to a host behind a router or serving one. */
    const keyed = { ...base, secrets: { ...base.secrets, SANOMA_ROUTER_SECRET: secret("SANOMA_ROUTER_SECRET") } };
    const noSecret = (told: Record<string, unknown>) =>
      noSecretIn(
        Object.values(values),
        Object.fromEntries(Object.entries(told).map(([what, value]) => [what, JSON.stringify(value)])),
      );
    const bound = (script: string) =>
      Object.fromEntries(fake.state.scripts[script]!.bindings.map((b) => [b.name, b] as const));
    const hostnames = () =>
      Object.values(fake.state.domains)
        .map((d) => d.hostname)
        .toSorted();

    it("runs on the image's port, with no secret value in its plan or state", async () => {
      const desired = { ...base, name: "derived" };
      const plan = await op("plan", { desired });
      const made = await op("create", { desired });
      expect(made.state).toMatchObject({ name: "derived", port: 3000, ref: "main" });
      const read = await op("read", { id: "derived" });
      expect(noSecret({ plan, state: made, read })).toMatchObject({ ok: true });
    });

    it("binds a routed company's address and its secret, plans nothing after, and unbinds all three once `agents` is left out", async () => {
      const agents = { url: "https://mcp.acme.example/mcp", company: "acme" };
      const desired = { ...keyed, name: "acme", agents };
      const plan = await op("plan", { desired });
      const made = await op("create", { desired });
      expect(made.state.agents).toEqual(agents);
      expect(bound("sanoma-acme")).toMatchObject({
        SANOMA_AGENT_URL: { type: "plain_text", text: agents.url },
        SANOMA_COMPANY: { type: "plain_text", text: "acme" },
        // Its text is the upload's alone (the driver's tests read it there): the account shows a secret's name.
        SANOMA_ROUTER_SECRET: { type: "secret_text" },
      });
      const read = await op("read", { id: "acme" });
      expect(read.state.agents).toEqual(agents);
      expect(await op("plan", { id: "acme", desired })).toMatchObject({ action: "none" });
      expect(noSecret({ plan, state: made, read })).toMatchObject({ ok: true });
      // A binding deleted by hand: read as no address, never a read that fails, and written again.
      const script = fake.state.scripts["sanoma-acme"]!;
      script.bindings = script.bindings.filter((b) => b.name !== "SANOMA_COMPANY");
      expect((await op("read", { id: "acme" })).state).not.toHaveProperty("agents");
      expect(await op("plan", { id: "acme", desired })).toMatchObject({ action: "update" });
      expect((await op("update", { id: "acme", desired })).state.agents).toEqual(agents);
      // As apply gives it once the data file leaves `agents` out: neither the address nor the secret.
      const unrouted = { ...base, name: "acme" };
      expect(await op("plan", { id: "acme", desired: unrouted })).toMatchObject({ action: "update" });
      const after = await op("update", { id: "acme", desired: unrouted });
      expect(after.state).not.toHaveProperty("agents");
      expect(Object.keys(bound("sanoma-acme")).filter((name) => /AGENT_URL|COMPANY|ROUTER/.test(name))).toEqual([]);
      await op("delete", { id: "acme" });
    });

    it("attaches the config's router's hostname beside the app's with the master secret, and detaches it once the config serves none", async () => {
      const hostname = "internal.acme.example";
      const plain = { ...base, name: "router", hostname };
      // As apply gives it for a config with `router: { hostname }`.
      const serving = { ...keyed, name: "router", hostname, routerHostname: "mcp.acme.example" };
      const made = await op("create", { desired: serving });
      expect(made.state).toMatchObject({ hostname, routerHostname: "mcp.acme.example", url: `https://${hostname}` });
      expect(hostnames()).toEqual([hostname, "mcp.acme.example"]);
      expect(bound("sanoma-router")).toMatchObject({
        SANOMA_ROUTER_HOSTNAME: { type: "plain_text", text: "mcp.acme.example" },
        SANOMA_ROUTER_SECRET: { type: "secret_text" },
      });
      expect(noSecret({ state: made })).toMatchObject({ ok: true });
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
      expect(Object.keys(bound("sanoma-router")).filter((name) => /ROUTER/.test(name))).toEqual([]);
      // Attached again, then deleted with the Worker: nothing of Sanoma's is left attached.
      await op("update", { id: "router", desired: serving });
      await op("delete", { id: "router" });
      expect(fake.state.domains).toEqual({});
    });
  });
});
