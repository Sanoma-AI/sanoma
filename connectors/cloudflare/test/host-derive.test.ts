import { checkDerivedHost, noSecretIn } from "sanoma/testing/host";
import { type CallContext, memorySecrets } from "sanoma/workflows";
import { secret } from "sanoma/workflows/resources";
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
