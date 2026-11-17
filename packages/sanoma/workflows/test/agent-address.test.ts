import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  type AgentAddress,
  agentAddressAt,
  agentAddressFrom,
  agentResourceMetadata,
  bearerJws,
  checkAgentAddress,
  companyOfTag,
  companyPrefix,
  NO_AGENT_ADDRESS,
  resourceMetadataOf,
  routedAgentAddress,
  routerAddressOf,
  routerSecretFor,
  routerSecretFrom,
  sameSecret,
} from "../src/index.ts";

// An instance's one agent address: made from the app's URL or the launcher's environment,
// written as it is compared, and refused when the staff login could not serve it.

const APP = "https://acme.example";
const ADDRESS: AgentAddress = { issuer: `${APP}/auth/better-auth`, resource: `${APP}/mcp` };
/** A company's secret at a router, as one is: 32 visible ASCII characters or more. */
const SECRET = "s3cret-of-acme-at-the-router-0123456789";
/** A router's host, and the address of the company `acme` behind it. */
const ROUTER = "https://mcp.router.example";
const ROUTED: AgentAddress = {
  issuer: ROUTER,
  resource: `${ROUTER}/mcp`,
  router: { company: "acme", secret: SECRET },
};

describe("agentAddressAt", () => {
  it("makes one address from an app's URL, however it is written: no trailing slash, no default port", () => {
    for (const url of [APP, `${APP}/`, "HTTPS://Acme.Example:443/", `${APP}//`]) {
      expect(agentAddressAt(url), url).toEqual(ADDRESS);
    }
    expect(agentAddressAt("http://10.0.0.7:3000/")).toEqual({
      issuer: "http://10.0.0.7:3000/auth/better-auth",
      resource: "http://10.0.0.7:3000/mcp",
    });
  });

  it("refuses what is no origin: a path, a query, a fragment, a user, no scheme", () => {
    for (const url of [
      `${APP}/app`,
      `${APP}/?x=1`,
      `${APP}/#x`,
      "https://ada@acme.example",
      "acme.example",
      "ftp://acme.example",
      "",
    ]) {
      expect(() => agentAddressAt(url), url).toThrow(`${JSON.stringify(url)} is not where an app is served`);
    }
  });
});

describe("agentAddressFrom", () => {
  it("reads the hostname first, then the instance's own URL, each trimmed, and none from neither", () => {
    expect(agentAddressFrom({ SANOMA_HOSTNAME: " Acme.Example " })).toEqual(ADDRESS);
    expect(agentAddressFrom({ SANOMA_HOSTNAME: "acme.example", SANOMA_HOST_URL: "http://10.0.0.7:3000" })).toEqual(
      ADDRESS,
    );
    // What a hostname cannot say: a port, an address, a single label, plain http.
    for (const [url, origin] of [
      ["http://10.0.0.7:3000/ ", "http://10.0.0.7:3000"],
      ["http://intranet", "http://intranet"],
      ["https://acme.acme-co.workers.dev/", "https://acme.acme-co.workers.dev"],
    ]) {
      expect(agentAddressFrom({ SANOMA_HOSTNAME: "", SANOMA_HOST_URL: url }), url).toEqual(agentAddressAt(origin!));
    }
    for (const env of [{}, { SANOMA_HOSTNAME: "", SANOMA_HOST_URL: " " }]) {
      expect(agentAddressFrom(env)).toBeUndefined();
    }
  });

  it("names the variable whose value gives no address", () => {
    for (const hostname of ["https://acme.example", "acme.example:8443", "acme.example/mcp", "acme"]) {
      expect(() => agentAddressFrom({ SANOMA_HOSTNAME: hostname }), hostname).toThrow(
        `SANOMA_HOSTNAME is ${JSON.stringify(hostname)}: write the hostname`,
      );
    }
    for (const url of ["acme.example", "https://acme.example/app", "ftp://acme.example", "https://acme.example?x"]) {
      expect(() => agentAddressFrom({ SANOMA_HOST_URL: url }), url).toThrow(
        `SANOMA_HOST_URL: ${JSON.stringify(url)} is not where an app is served`,
      );
    }
    // A hostname that is one wins over a URL that is none: the URL is not read.
    expect(agentAddressFrom({ SANOMA_HOSTNAME: "acme.example", SANOMA_HOST_URL: "nothing" })).toEqual(ADDRESS);
  });

  it("reads a router's address first: its /mcp URL, the company's id and the router's secret, all three", () => {
    const env = { SANOMA_AGENT_URL: ` ${ROUTER}/mcp `, SANOMA_COMPANY: " acme ", SANOMA_ROUTER_SECRET: SECRET };
    expect(agentAddressFrom(env)).toEqual(ROUTED);
    // The router's wins over the instance's own hostname and URL, which are not read.
    expect(agentAddressFrom({ ...env, SANOMA_HOSTNAME: "acme.example", SANOMA_HOST_URL: "nothing" })).toEqual(ROUTED);
    expect(agentAddressFrom({ ...env, SANOMA_AGENT_URL: "http://127.0.0.1:8787/mcp" })).toEqual({
      ...ROUTED,
      issuer: "http://127.0.0.1:8787",
      resource: "http://127.0.0.1:8787/mcp",
    });
    // Without the router's URL the company and the secret name no address: the instance's own rule.
    expect(agentAddressFrom({ SANOMA_COMPANY: "acme", SANOMA_ROUTER_SECRET: SECRET })).toBeUndefined();
    expect(agentAddressFrom({ ...env, SANOMA_AGENT_URL: " ", SANOMA_HOSTNAME: "acme.example" })).toEqual(ADDRESS);
  });

  it("names the router's variable whose value gives no address", () => {
    const env = { SANOMA_AGENT_URL: `${ROUTER}/mcp`, SANOMA_COMPANY: "acme", SANOMA_ROUTER_SECRET: SECRET };
    for (const url of [
      ROUTER,
      `${ROUTER}/`,
      `${ROUTER}/mcp/`,
      `${ROUTER}/agents`,
      `${ROUTER}/mcp?x=1`,
      "mcp.router.example/mcp",
    ]) {
      expect(() => agentAddressFrom({ ...env, SANOMA_AGENT_URL: url }), url).toThrow(
        `SANOMA_AGENT_URL is ${JSON.stringify(url)}: write the router's agent surface`,
      );
    }
    for (const company of ["", "acme.eu", "acme corp", "acme/1", "ac:me"]) {
      expect(() => agentAddressFrom({ ...env, SANOMA_COMPANY: company }), company).toThrow(
        `SANOMA_COMPANY is ${JSON.stringify(company)}: write this company's id at the router`,
      );
    }
    expect(() => agentAddressFrom({ ...env, SANOMA_ROUTER_SECRET: " " })).toThrow(
      "SANOMA_ROUTER_SECRET is not set: SANOMA_AGENT_URL names a router",
    );
    // A secret that could not be sent in a header, or is short, is refused by its variable's name.
    for (const [secret, why] of [
      ["short-one", "it must have 32 characters or more"],
      [`${SECRET} with spaces`, "it must be visible ASCII"],
      [`${SECRET}\u00e9`, "it must be visible ASCII"],
      [`${SECRET}\nx-injected: 1`, "it must be visible ASCII"],
    ] as const) {
      const refused = () => agentAddressFrom({ ...env, SANOMA_ROUTER_SECRET: secret });
      expect(refused, secret).toThrow(`SANOMA_ROUTER_SECRET is not one a router can send: ${why}`);
      // The secret is never in what is said.
      expect(refused, secret).not.toThrow(secret.slice(0, 9));
    }
    expect(() => agentAddressFrom({ ...env, SANOMA_COMPANY: "a.b" })).not.toThrow(/s3cret/);
  });

  it("is named, with both variables, by what an instance without one says", () => {
    expect(NO_AGENT_ADDRESS).toMatch(/no agent address\. Set SANOMA_HOSTNAME .* or SANOMA_HOST_URL /);
  });
});

describe("checkAgentAddress", () => {
  it("takes what agentAddressAt makes, and refuses an address the login could not serve", () => {
    for (const url of [APP, "http://10.0.0.7:3000"]) expect(() => checkAgentAddress(agentAddressAt(url))).not.toThrow();
    expect(() => checkAgentAddress({ ...ADDRESS, issuer: `${ADDRESS.issuer}/` })).toThrow(/as it is compared/);
    expect(() => checkAgentAddress({ ...ADDRESS, issuer: APP })).toThrow(/its path must be \/auth\/better-auth/);
    expect(() => checkAgentAddress({ ...ADDRESS, resource: APP })).toThrow(/it needs a path/);
  });

  it("takes a router's address: an issuer with no path, its /mcp, a company's id and a secret; and no third shape", () => {
    expect(() => checkAgentAddress(ROUTED)).not.toThrow();
    expect(() => checkAgentAddress(routedAgentAddress(`${ROUTER}/mcp`, ROUTED.router!))).not.toThrow();
    expect(routedAgentAddress(`${ROUTER}/mcp`, ROUTED.router!)).toEqual(ROUTED);
    // An own-host issuer with a company, or a root issuer without one, is neither shape.
    expect(() => checkAgentAddress({ ...ADDRESS, router: ROUTED.router })).toThrow(
      /a router's issuer is its origin, with no path/,
    );
    expect(() => checkAgentAddress({ issuer: ROUTED.issuer, resource: ROUTED.resource })).toThrow(
      /its path must be \/auth\/better-auth/,
    );
    expect(() => checkAgentAddress({ ...ROUTED, issuer: `${ROUTER}/auth` })).toThrow(/with no path/);
    expect(() => checkAgentAddress({ ...ROUTED, resource: `${ROUTER}/agents` })).toThrow(
      /a router's resource is its issuer's \/mcp/,
    );
    expect(() => checkAgentAddress({ ...ROUTED, resource: "https://other.example/mcp" })).toThrow(
      /a router's resource is its issuer's \/mcp/,
    );
    for (const company of ["", "acme.eu", "a b", "a/b"]) {
      expect(() => checkAgentAddress({ ...ROUTED, router: { ...ROUTED.router!, company } }), company).toThrow(
        /the agent address's company is .*: letters, digits, - and _ only/,
      );
    }
    for (const secret of ["", "short", `${SECRET} `, `${SECRET}\r\n`]) {
      expect(() => checkAgentAddress({ ...ROUTED, router: { company: "acme", secret } }), secret).toThrow(
        /the agent address's router has no secret a router can send \((it is not set|it must)/,
      );
    }
    expect(() => checkAgentAddress({ ...ROUTED, router: { company: "acme", secret: "" } })).toThrow(
      /the agent address's router has no secret/,
    );
  });
});

describe("resourceMetadataOf", () => {
  it("is RFC 9728's well-known path with the resource's own, on the resource's origin", () => {
    expect(resourceMetadataOf(ADDRESS)).toEqual({
      path: "/.well-known/oauth-protected-resource/mcp",
      url: `${APP}/.well-known/oauth-protected-resource/mcp`,
    });
    // A routed address's is on the router's origin: what an instance behind it names in its 401.
    expect(resourceMetadataOf(ROUTED)).toEqual({
      path: "/.well-known/oauth-protected-resource/mcp",
      url: `${ROUTER}/.well-known/oauth-protected-resource/mcp`,
    });
  });
});

describe("a router's secrets", () => {
  it("reads SANOMA_ROUTER_SECRET trimmed, none when blank, and refuses one that is no header's value or short", () => {
    expect(routerSecretFrom({})).toBeUndefined();
    expect(routerSecretFrom({ SANOMA_ROUTER_SECRET: "  " })).toBeUndefined();
    expect(routerSecretFrom({ SANOMA_ROUTER_SECRET: ` ${SECRET}\n` })).toBe(SECRET);
    expect(routerSecretFrom({ SANOMA_ROUTER_SECRET: "x".repeat(32) })).toBe("x".repeat(32));
    for (const bad of ["x".repeat(31), `${"x".repeat(32)} y`, `${"x".repeat(32)}\u0000`, `${"x".repeat(32)}ä`]) {
      expect(() => routerSecretFrom({ SANOMA_ROUTER_SECRET: bad }), bad).toThrow(
        /^SANOMA_ROUTER_SECRET is not one a router can send: it must /,
      );
    }
  });

  it("derives each company's own from the master: HMAC-SHA256 over its id, in hex, itself a secret a router can send", async () => {
    const master = "m".repeat(32);
    const acme = await routerSecretFor(master, "acme");
    expect(acme).toBe(createHmac("sha256", master).update("acme").digest("hex"));
    expect(acme).toBe("2d62824c6d994aacf7993bd87ad33fe48a56be2faa389806540c3de76c38f1f2");
    expect(routerSecretFrom({ SANOMA_ROUTER_SECRET: acme })).toBe(acme);
    // Another company's, or another master's, is another secret.
    expect(await routerSecretFor(master, "globex")).not.toBe(acme);
    expect(await routerSecretFor(`${master}x`, "acme")).not.toBe(acme);
    expect(() => routedAgentAddress(`${ROUTER}/mcp`, { company: "acme", secret: acme })).not.toThrow();
  });

  it("compares two secrets whole, whatever their lengths", () => {
    expect(sameSecret(SECRET, SECRET)).toBe(true);
    for (const other of ["", SECRET.slice(1), `${SECRET}x`, SECRET.toUpperCase()]) {
      expect(sameSecret(other, SECRET), other).toBe(false);
    }
  });
});

describe("what a router and the instances behind it share", () => {
  it("reads a company off a code's or a refresh token's tag, the inverse of the prefix, checking nothing", () => {
    expect(companyOfTag(`${companyPrefix("acme")}Zx81`)).toBe("acme");
    expect(companyOfTag("acme.Zx81.more")).toBe("acme");
    for (const none of ["", "acme", ".acme", "acme."]) expect(companyOfTag(none), none).toBeUndefined();
  });

  it("makes a router's address from its hostname, and RFC 9728's document from any address", () => {
    expect(routerAddressOf("mcp.router.example")).toEqual({ issuer: ROUTER, resource: `${ROUTER}/mcp` });
    expect(agentResourceMetadata(ROUTED)).toEqual({
      resource: `${ROUTER}/mcp`,
      authorization_servers: [ROUTER],
      bearer_methods_supported: ["header"],
    });
    expect(agentResourceMetadata(ADDRESS)).toEqual({
      resource: `${APP}/mcp`,
      authorization_servers: [`${APP}/auth/better-auth`],
      bearer_methods_supported: ["header"],
    });
  });

  it("takes a bearer only when it is a JWS in compact form, its scheme in any case", () => {
    expect(bearerJws("Bearer a-b.c_d.e")).toBe("a-b.c_d.e");
    expect(bearerJws("bEARER a.b.c")).toBe("a.b.c");
    for (const none of [null, "", "Bearer", "Bearer a.b", "Bearer a.b.c.d", "Basic a.b.c", "Bearer a.b.c x"]) {
      expect(bearerJws(none), String(none)).toBeUndefined();
    }
  });
});
