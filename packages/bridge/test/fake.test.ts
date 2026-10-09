import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeError, readPins } from "@sanoma/bridge";
import { fakeBridge } from "@sanoma/bridge/fake";

const testdata = fileURLToPath(new URL("../testdata/", import.meta.url));
const pins = readPins();
const github = pins["integrations/github"]!;
const stripe = pins["stripe/stripe"]!;
const config = JSON.stringify({ owner: "Sanoma-AI", token: "not-a-real-token" });

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );

/** The error a call failed with, as a BridgeError. */
async function failure(promise: Promise<unknown>): Promise<BridgeError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BridgeError);
  return error as BridgeError;
}

// These replay the checked-in fixtures whatever SANOMA_LIVE says: recording GitHub needs a token.
beforeEach(() => {
  vi.stubEnv("SANOMA_LIVE", "");
  vi.stubEnv("SANOMA_RECORD", "");
});

describe("readPins", () => {
  it("reads the pinned releases, keyed by source", () => {
    expect(Object.keys(pins).toSorted()).toEqual(["hashicorp/null", "integrations/github", "stripe/stripe"]);
    expect(github).toEqual({
      source: "integrations/github",
      version: "6.13.0",
      sha256: "2d688e8383ff669297bbb6461f7eb05168f53fe76d3233fdb431e318efedb98f",
    });
  });
});

describe("fakeBridge", () => {
  it("serves the recorded schemas of GitHub (protocol 5) and Stripe (protocol 6)", async () => {
    const bridge = fakeBridge();
    const gh = await bridge.schema(github);
    expect(gh.schema.protocol).toBe(5);
    expect(gh.sha256).toBe(github.sha256);
    expect(gh.schema).toMatchObject({ source: "integrations/github", version: "6.13.0", formatVersion: 1 });
    expect(gh.schema.resources.github_repository?.schemaVersion).toBe(1);
    expect(gh.schema.resources.github_repository?.block.attributes.name).toMatchObject({
      type: "string",
      required: true,
    });
    expect(gh.schema.resources.github_repository?.block.blocks.pages).toMatchObject({ nesting: "list", maxItems: 1 });

    const st = await bridge.schema(stripe);
    expect(st.schema.protocol).toBe(6);
    expect(Object.keys(st.schema.resources)).toEqual(
      expect.arrayContaining(["stripe_product", "stripe_webhook_endpoint"]),
    );
    expect(st.schema.providerConfig.attributes.api_key).toMatchObject({ sensitive: true });
  });

  it("imports the recorded GitHub repository, then reads it back", async () => {
    const bridge = fakeBridge();
    await bridge.configure(github, config);
    const imported = await bridge.import(github, "github_repository", "provider-bridge");
    expect(imported.warnings).toEqual([]);
    expect(imported.resources).toHaveLength(1);
    const [repo] = imported.resources;
    expect(repo).toMatchObject({ typeName: "github_repository", schemaVersion: 1 });
    expect(new TextDecoder().decode(repo!.private)).toBe('{"schema_version":"1"}');
    const state = JSON.parse(repo!.stateJson) as Record<string, unknown>;
    expect(state).toMatchObject({ id: "provider-bridge", full_name: "Sanoma-AI/provider-bridge", fork: "false" });

    const read = await bridge.read(github, "github_repository", repo!.stateJson, repo!.private, repo!.schemaVersion);
    expect(read.gone).toBe(false);
    expect(read.resource?.typeName).toBe("github_repository");
    expect(JSON.parse(read.resource!.stateJson)).toMatchObject({ id: "provider-bridge", default_branch: "main" });

    expect(bridge.calls.map((c) => [c.method, c.id])).toEqual([
      ["configure", undefined],
      ["import", "provider-bridge"],
      ["read", "provider-bridge"],
    ]);
    expect(bridge.calls[1]).toEqual({
      method: "import",
      ref: github,
      typeName: "github_repository",
      id: "provider-bridge",
    });
  });

  it("finds a read by the id in the state, whatever else the state holds", async () => {
    const bridge = fakeBridge();
    await bridge.configure(github, config);
    const read = await bridge.read(github, "github_repository", JSON.stringify({ id: "sanoma" }));
    expect(JSON.parse(read.resource!.stateJson)).toMatchObject({ full_name: "Sanoma-AI/sanoma" });
  });

  it("replays a recorded error with its diagnostics", async () => {
    const bridge = fakeBridge();
    await bridge.configure(github, config);
    const error = await failure(bridge.import(github, "github_branch_protection", "provider-bridge:main"));
    expect(error.code).toBe("failed_precondition");
    expect(error.message).toContain("could not find a branch protection rule with the pattern 'main'");
    expect(error.diagnostics).toEqual([
      {
        severity: "error",
        summary: "could not find a branch protection rule with the pattern 'main'",
        detail: "",
        attributePath: "",
      },
    ]);
  });

  it("names the fixture to record when none covers a call", async () => {
    const bridge = fakeBridge();
    await bridge.configure(github, config);
    const missingImport = await failure(bridge.import(github, "github_repository", "nope"));
    expect(missingImport.code).toBe("not_found");
    expect(missingImport.message).toContain("replies/integrations_github_6.13.0/github_repository/nope/import.json");
    expect(missingImport.message).toContain("SANOMA_RECORD=1");

    const missingRead = await failure(bridge.read(github, "github_repository", JSON.stringify({ id: "nope" })));
    expect(missingRead.code).toBe("not_found");
    expect(missingRead.message).toContain("github_repository/nope/read.json");

    const missingSchema = await failure(bridge.schema({ source: "hashicorp/random", version: "3.7.2" }));
    expect(missingSchema.code).toBe("failed_precondition");
    expect(missingSchema.message).toContain("schemas/hashicorp_random_3.7.2.json");
  });

  it("refuses what the bridge refuses", async () => {
    const bridge = fakeBridge();
    expect((await failure(bridge.import(github, "github_repository", "provider-bridge"))).message).toBe(
      "integrations/github 6.13.0 is not configured; call Configure first",
    );
    expect((await failure(bridge.configure(github, "[]"))).code).toBe("invalid_argument");
    await bridge.configure(github, config);
    await bridge.configure(github, config); // the same config again: a no-op
    const other = await failure(bridge.configure(github, JSON.stringify({ owner: "someone-else" })));
    expect(other.code).toBe("failed_precondition");
    expect(other.message).toContain("already configured with a different config");
    expect((await failure(bridge.import(github, "github_nope", "x"))).code).toBe("invalid_argument");
    expect((await failure(bridge.read(github, "github_repository", "not json"))).code).toBe("invalid_argument");
    const pin = await failure(bridge.schema({ ...github, sha256: "0".repeat(64) }));
    expect(pin.code).toBe("failed_precondition");
    expect(pin.message).toContain("refusing release");

    await bridge.close(github);
    await bridge.configure(github, JSON.stringify({ owner: "someone-else" })); // after close, any config
    await bridge.close();
    expect((await failure(bridge.import(github, "github_repository", "provider-bridge"))).code).toBe(
      "failed_precondition",
    );
  });
});

describe("the fixtures", () => {
  const replies = files(join(testdata, "replies"));

  it("record which secrets were scrubbed", () => {
    expect(replies.length).toBeGreaterThan(0);
    for (const file of replies) {
      const { scrubbed } = JSON.parse(readFileSync(file, "utf8")) as { scrubbed: string[] };
      expect(scrubbed, file).toEqual(["$GITHUB_TOKEN"]);
    }
  });

  it("hold no credentials", () => {
    const credential = /\b(ghp|gho|ghs|ghu|github_pat|sk|rk|whsec)_/; // GitHub tokens, Stripe keys, webhook secrets
    for (const file of files(testdata)) {
      expect(credential.test(readFileSync(file, "utf8")), file).toBe(false);
    }
  });
});
