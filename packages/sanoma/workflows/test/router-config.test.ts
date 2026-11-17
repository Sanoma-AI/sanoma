import { describe, expect, it } from "vitest";
import { collection } from "../src/data.ts";
import { resolveConfig, type Router, type SanomaConfig } from "../src/index.ts";

// The config's `router`: the agents' router the app serves (sanoma#777), checked when the
// config is resolved, as `login` is, so `sanoma check` refuses one the app could not serve.

const companies = collection({
  name: "companies",
  key: "slug",
  fields: { slug: "text", url: "text", home: { type: "text", optional: true }, status: { enum: ["pending", "live"] } },
});
const config = (router: unknown): SanomaConfig => ({
  workflows: [],
  connectors: [],
  collections: [companies],
  router: router as Router,
});
const good = { hostname: "mcp.acme.example", companies: { collection: "companies" } };
/** The good router, routing only to the records `given` says. */
const live = (given: unknown) => config({ ...good, companies: { collection: "companies", live: given } });

describe("the config's router", () => {
  it("resolves with its hostname in lower case and its fields named: `url` unless said, every record unless `live`", () => {
    expect(resolveConfig(config(good)).router).toEqual({
      hostname: "mcp.acme.example",
      companies: { collection: "companies", url: "url" },
    });
    const full = {
      hostname: " MCP.Acme.Example ",
      companies: { collection: "companies", url: "home", live: { field: "status", is: "live" } },
    };
    expect(resolveConfig(config(full)).router).toEqual({
      hostname: "mcp.acme.example",
      companies: { collection: "companies", url: "home", live: { field: "status", is: ["live"] } },
    });
    const several = { ...good, companies: { ...good.companies, live: { field: "status", is: ["live", "pending"] } } };
    expect(resolveConfig(config(several)).router?.companies.live?.is).toEqual(["live", "pending"]);
    expect(resolveConfig({ workflows: [], connectors: [] }).router).toBeUndefined();
  });

  it("is refused for a hostname that is none: a URL, a port, a path, a single label", () => {
    for (const hostname of [
      "https://mcp.acme.example",
      "mcp.acme.example:8443",
      "mcp.acme.example/mcp",
      "mcp",
      "",
      7,
    ]) {
      expect(() => resolveConfig(config({ ...good, hostname })), String(hostname)).toThrow(
        /^The config's `router\.hostname`, .*, is not a hostname: write the one the router answers at over HTTPS/,
      );
    }
    expect(() => resolveConfig(config({ companies: good.companies }))).toThrow(/^The config's `router\.hostname`/);
  });

  it("is refused for a collection the company does not have, naming those it has", () => {
    expect(() => resolveConfig(config({ ...good, companies: { collection: "customers" } }))).toThrow(
      'The config\'s `router.companies.collection`, "customers", is no collection of this company: declare it in resources/data.ts (it has companies)',
    );
    expect(() => resolveConfig({ ...config(good), collections: [] })).toThrow(
      /is no collection of this company: declare it in resources\/data\.ts$/,
    );
    for (const listed of [undefined, "companies", {}, { collection: "" }]) {
      expect(() => resolveConfig(config({ ...good, companies: listed })), JSON.stringify(listed)).toThrow(
        /^The config's `router\.companies\.collection` is not set/,
      );
    }
  });

  it("is refused for a field the collection does not have, or a `live` that names no value", () => {
    expect(() => resolveConfig(config({ ...good, companies: { collection: "companies", url: "href" } }))).toThrow(
      'The config\'s `router.companies.url`, "href", is no field of the collection companies: it has slug, url, home, status',
    );
    expect(() => resolveConfig(live({ field: "state", is: "live" }))).toThrow(
      /^The config's `router\.companies\.live\.field`, "state", is no field of the collection companies/,
    );
    for (const is of [undefined, "", [], ["live", 1]]) {
      expect(() => resolveConfig(live({ field: "status", is })), JSON.stringify(is)).toThrow(
        /^The config's `router\.companies\.live\.is` is not a value or a list of them/,
      );
    }
  });
});
