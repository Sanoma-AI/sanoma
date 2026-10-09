import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Bridge, BridgeError, type BridgeLog, readPins, startBridge } from "@sanoma/bridge";
import { fakeBridge } from "@sanoma/bridge/fake";
import { buildBridge } from "../scripts/download-bridge.ts";

// SANOMA_LIVE=1 builds provider-bridge from the sibling checkout and runs hashicorp/null (no
// credentials; downloaded once from registry.opentofu.org into provider-bridge's test cache).
const live = process.env.SANOMA_LIVE === "1";
const cacheHome =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Caches")
    : (process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
const nullProvider = readPins()["hashicorp/null"]!;
const logs: BridgeLog[] = [];
const options = () => ({
  bin: process.env.SANOMA_BRIDGE_BIN || buildBridge(),
  cacheDir: join(cacheHome, "provider-bridge-test"),
  logger: (line: BridgeLog) => logs.push(line),
});

describe.skipIf(!live)("startBridge (SANOMA_LIVE=1)", () => {
  let bridge: Bridge;

  beforeAll(async () => {
    bridge = await startBridge(options());
  }, 300_000);
  afterAll(() => bridge?.stop());

  it("serves hashicorp/null's schema, configures it and reads a null_resource", async () => {
    const { schema, sha256 } = await bridge.schema(nullProvider);
    expect(schema.protocol).toBe(5);
    expect(sha256).toBe(nullProvider.sha256);
    expect(schema.resources.null_resource?.block.attributes.triggers).toMatchObject({ type: ["map", "string"] });

    await expect(bridge.configure(nullProvider, "{}")).resolves.toEqual({ warnings: [] });
    const read = await bridge.read(nullProvider, "null_resource", JSON.stringify({ id: "1" }));
    expect(read.gone).toBe(false);
    expect(JSON.parse(read.resource!.stateJson)).toEqual({ id: "1", triggers: null });

    // With the version the state was written at, the provider upgrades it first.
    const upgraded = await bridge.read(nullProvider, "null_resource", '{"id":"2","triggers":{"a":"b"}}', undefined, 0);
    expect(JSON.parse(upgraded.resource!.stateJson)).toEqual({ id: "2", triggers: { a: "b" } });
  });

  it("maps the bridge's errors", async () => {
    const wrongPin = await bridge.schema({ ...nullProvider, sha256: "0".repeat(64) }).catch((e: unknown) => e);
    expect(wrongPin).toBeInstanceOf(BridgeError);
    expect(wrongPin).toMatchObject({
      code: "failed_precondition",
      message: expect.stringContaining("refusing release"),
    });
    const unknownType = await bridge.read(nullProvider, "null_nope", "{}").catch((e: unknown) => e);
    expect(unknownType).toMatchObject({ code: "invalid_argument" });

    await bridge.close(nullProvider);
    const closed = await bridge.read(nullProvider, "null_resource", '{"id":"1"}').catch((e: unknown) => e);
    expect(closed).toMatchObject({
      code: "failed_precondition",
      message: "hashicorp/null 3.3.2 is not configured; call Configure first",
    });
    // stderr reaches the logger as JSON lines.
    expect(logs).toContainEqual(
      expect.objectContaining({ level: "WARN", msg: "rpc failed", code: "failed_precondition" }),
    );
  });

  it("records fixtures through fakeBridge, which then replays them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sanoma-bridge-live-"));
    try {
      vi.stubEnv("SANOMA_RECORD", "1");
      const recording = fakeBridge({ fixtures: dir, bridge: options() });
      expect(recording.live).toBe(true);
      await recording.configure(nullProvider, "{}");
      const reply = await recording.read(nullProvider, "null_resource", '{"id":"7","triggers":{"k":"v"}}');
      await recording.stop();
      const fixture = JSON.parse(
        readFileSync(join(dir, "replies/hashicorp_null_3.3.2/null_resource/7/read.json"), "utf8"),
      );
      expect(fixture.provider).toEqual({ ...nullProvider, protocol: 5 });
      expect(fixture.scrubbed).toEqual([]);
      // The schema is written as the bridge returns it: the same bytes as the checked-in fixture.
      const schemaFile = "schemas/hashicorp_null_3.3.2.json";
      expect(readFileSync(join(dir, schemaFile), "utf8")).toBe(
        readFileSync(new URL(`../testdata/${schemaFile}`, import.meta.url), "utf8"),
      );

      vi.stubEnv("SANOMA_LIVE", "");
      const replay = fakeBridge({ fixtures: dir });
      expect((await replay.schema(nullProvider)).schema.version).toBe("3.3.2");
      await replay.configure(nullProvider, "{}");
      expect(await replay.read(nullProvider, "null_resource", '{"id":"7"}')).toEqual(reply);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
