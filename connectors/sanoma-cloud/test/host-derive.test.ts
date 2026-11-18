import { checkDerivedHost } from "sanoma/testing/host";
import { describe, expect, it } from "vitest";
import { host } from "../src/connector.ts";

// `cloud.host`, aligned with `cloudflare.host`: its decisions alone, its repository and branch derived.

describe("cloud.host", () => {
  it("passes the derived-host checks", () => {
    expect(checkDerivedHost(host, { hostname: "acme.sanoma.work" }).filter((check) => !check.ok)).toEqual([]);
  });

  it("takes its address at sanoma.work only, an address the Cloud gives, and no name", () => {
    const database = "store";
    expect(host({ hostname: "acme.sanoma.work", database }).desired).toEqual({
      hostname: "acme.sanoma.work",
      database,
    });
    for (const hostname of [
      "www.acme.com",
      "-acme.sanoma.work",
      "ab.sanoma.work",
      "a--b.sanoma.work",
      "www.sanoma.work",
    ]) {
      expect(() => host({ hostname, database }), hostname).toThrow(/sanoma\.work/);
    }
    expect(host({ hostname: "www-acme.sanoma.work", database }).desired.hostname).toBe("www-acme.sanoma.work");
    expect(() => host({ name: "acme", hostname: "acme.sanoma.work", database } as never)).toThrow(/name/);
  });
});
