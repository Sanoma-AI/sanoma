import { fileURLToPath } from "node:url";
import { bluesky } from "@sanoma-ai/connector-bluesky";
import { ghost } from "@sanoma-ai/connector-ghost";
import { fakeGhost } from "@sanoma-ai/connector-ghost/fake";
import { resend } from "@sanoma-ai/connector-resend";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  memoryLedger,
  type ResolvedConfig,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  startWorker,
  type Worker,
  withSetup,
} from "../src/index.ts";
import { demoState, reseed, runScenarios } from "../src/scenarios.ts";
import announce from "./fixtures/announce.ts";
import { outbound } from "./fixtures/outbound/resources/data.ts";
import outboundNext from "./fixtures/outbound/workflows/outbound-next.ts";
import { pending, rootWith, waitFor, withoutSetup } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. A demo: the instance on its connectors' fakes (`fakes: "instance"`),
// seeded by `reseed` from the world (a scenario with no When) and its moments (tagged scenarios).

const root = rootWith(
  {
    "scenarios/world.feature": `Feature: The world
  Acme's pipeline, and a post already on the blog.

  Scenario: Acme's pipeline
    Given data.outbound "Acme" has
      | contact | ada@acme.test |
      | stage   | researched    |
      | owner   | leon          |
    And data.outbound "Globex" has
      | stage | contacted |
    And a post titled "Old news" exists
`,
    "scenarios/broken.feature": `Feature: A broken world

  Scenario: A flaky blog
    Given ghost.post.publish fails once
`,
    "scenarios/moments.feature": `Feature: Moments

  @moment(leon,/inbox)
  Scenario: The launch copy waits for review
    When announce runs with
      | title    | Acme Pro             |
      | launchAt | 2030-01-01T09:00:00Z |
`,
  },
  fileURLToPath(new URL("./fixtures/outbound/", import.meta.url)),
);

const config: SanomaConfig = {
  workflows: [announce, outboundNext],
  connectors: [ghost, resend, bluesky],
  collections: [outbound],
  root,
  databaseUrl: testDatabaseUrl("demo"),
  ledger: memoryLedger(),
};

describe("resolveConfig with fakes: instance", () => {
  it("makes each vendor's one fake its driver and every sandbox run's, keeping the collections on the database", () => {
    const resolved = resolveConfig(config, { fakes: "instance" });
    const blog = resolved.instanceFakes!.get("ghost")!;
    expect([...resolved.instanceFakes!.keys()]).toEqual(["ghost", "resend", "bluesky"]);
    expect(resolved.driversByVendor.get("ghost")).toBe(blog.driver);
    expect(resolved.fakes.get("ghost")!()).toBe(blog);
    expect(resolved.drivers.get("ghost.post.create")).toBe(blog.driver.ops["post.create"]);
    // Made once per resolution: another has its own.
    expect(resolveConfig(config, { fakes: "instance" }).instanceFakes!.get("ghost")).not.toBe(blog);
    expect(resolveConfig(config).instanceFakes).toBeUndefined();
  });

  it("refuses a vendor whose connector attaches a driver and no fake", () => {
    const live = withSetup(withoutSetup(ghost), { driver: () => fakeGhost().driver });
    expect(() => resolveConfig({ ...config, connectors: [live, resend, bluesky] }, { fakes: "instance" })).toThrow(
      "The instance runs on fakes, but the connector of ghost attaches no fake, so it would run live; attach one (`withSetup`) or leave it out",
    );
  });
});

describe("reseed", () => {
  let resolved: ResolvedConfig;
  let worker: Worker;
  let client: SanomaClient;
  beforeAll(async () => {
    resolved = resolveConfig(config, { fakes: "instance" });
    worker = await startWorker(config, { resolved, promote: true, quiet: true, schedules: false });
    client = await SanomaClient.connect(config, { resolved });
  }, 60_000);
  afterAll(async () => {
    try {
      await client?.close();
    } finally {
      await worker?.stop();
      await resolved?.dataStore?.close();
    }
  });

  const leads = async () =>
    (await client.call("data.outbound.list", {}, { actor: "leon" })) as {
      key: string;
      record: Record<string, unknown>;
      updatedBy: string;
    }[];
  const titles = () =>
    Object.values((resolved.instanceFakes!.get("ghost")!.state as { posts: Record<string, { title: string }> }).posts)
      .map((p) => p.title)
      .toSorted();

  it("applies the world to the instance, starts each moment as its person and leaves its approval waiting", async () => {
    const state = await reseed(client, resolved);
    expect(state.worlds).toEqual(["Acme's pipeline"]);
    expect(state.problems).toEqual([
      expect.stringMatching(
        /^world "A flaky blog": Scenario "A flaky blog" injects a fault \("ghost\.post\.publish fails once"\)/,
      ),
    ]);
    expect(state.moments).toEqual([
      { person: "leon", path: "/inbox", scenario: "The launch copy waits for review", runId: expect.any(String) },
    ]);
    expect(demoState(resolved)).toBe(state);

    // The world's records, in the collections' table, read back through the operation.
    const rows = await leads();
    expect(rows.map((r) => r.key)).toEqual(["Acme", "Globex"]);
    expect(rows[0]).toMatchObject({
      record: { company: "Acme", contact: "ada@acme.test", stage: "researched", owner: "leon" },
      updatedBy: "scenarios",
    });

    // The moment's run, a sandbox run by leon, waits for its approval, on the instance's fakes.
    const { runId } = state.moments[0]!;
    await waitFor(pending(() => client, runId));
    expect(await client.run(runId)).toMatchObject({ status: "waiting", sandbox: "The launch copy waits for review" });
    expect((await client.ledger(runId)).find((r) => r.type === "run.started")).toMatchObject({
      actor: { id: "leon" },
    });
    expect(titles()).toEqual(["Acme Pro", "Old news"]);
  });

  it("goes on with the instance's fakes after a worker restart, where a run's own would be gone", async () => {
    const { runId } = demoState(resolved)!.moments[0]!;
    await worker.stop();
    worker = await startWorker(config, { resolved, promote: true, quiet: true, schedules: false });
    const [approval] = await client.approvals(runId);
    await client.decide(runId, { decision: "approve", by: { id: "marketing-lead" } }, approval!.id);
    expect(await client.result(runId)).toMatchObject({ post: expect.stringContaining("acme-pro") });
  });

  it("seeds afresh: the records and the fakes as the world has them, whatever was done since", async () => {
    await client.call(
      "data.outbound.save",
      { record: { company: "Initech", contact: "bo@initech.test", stage: "won", owner: "leon" } },
      {
        actor: "leon",
      },
    );
    expect((await leads()).map((r) => r.key)).toEqual(["Acme", "Globex", "Initech"]);
    const state = await reseed(client, resolved);
    expect((await leads()).map((r) => r.key)).toEqual(["Acme", "Globex"]);
    await waitFor(pending(() => client, state.moments[0]!.runId));
    expect(titles()).toEqual(["Acme Pro", "Old news"]);

    // Once more: the moment left waiting is cancelled, so only the new one waits.
    const again = await reseed(client, resolved);
    await waitFor(pending(() => client, again.moments[0]!.runId));
    expect(await client.run(state.moments[0]!.runId)).toMatchObject({ status: "cancelled" });
    expect((await client.runs({ status: "waiting" })).map((r) => r.runId)).toEqual([again.moments[0]!.runId]);
  });

  it("seeds one half: memory the fakes alone, as a copy of the database needs, and database the rest", async () => {
    const waiting = async () => (await client.runs({ status: "waiting" })).map((r) => r.runId);
    const before = await waiting();
    await client.call(
      "data.outbound.save",
      { record: { company: "Initech", contact: "bo@initech.test", stage: "won", owner: "leon" } },
      { actor: "leon" },
    );
    const memory = await reseed(client, resolved, { only: "memory" });
    expect(memory).toMatchObject({ worlds: ["Acme's pipeline"], moments: [] });
    expect(memory.problems).toEqual([expect.stringMatching(/^world "A flaky blog"/)]);
    expect(titles()).toEqual(["Old news"]);
    expect((await leads()).map((r) => r.key)).toEqual(["Acme", "Globex", "Initech"]);
    expect(await waiting()).toEqual(before);

    const database = await reseed(client, resolved, { only: "database" });
    expect((await leads()).map((r) => r.key)).toEqual(["Acme", "Globex"]);
    await waitFor(pending(() => client, database.moments[0]!.runId));
    expect(await waiting()).toEqual([database.moments[0]!.runId]);
    // The fakes kept what memory seeded; only the new moment's run added to them.
    expect(titles()).toEqual(["Acme Pro", "Old news"]);
  });
});

describe("runScenarios, as sanoma check runs them", () => {
  it("runs the tests and skips the worlds and the moments that decide nothing", async () => {
    const lines: string[] = [];
    const { passed, failed } = await runScenarios(config, {
      databaseUrl: testDatabaseUrl("demo_check"),
      log: (line) => lines.push(line),
    });
    expect(failed).toEqual([]);
    expect(passed).toEqual(["A researched lead is contacted", "A company with no lead is left alone"]);
    expect(lines.filter((l) => l.startsWith("skipped"))).toEqual([
      "skipped scenarios/broken.feature › A flaky blog: a world",
      "skipped scenarios/moments.feature › The launch copy waits for review: a moment",
      "skipped scenarios/world.feature › Acme's pipeline: a world",
    ]);
  });
});
