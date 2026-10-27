import type { SanomaClient } from "./client.ts";
import type { ResolvedConfig } from "./config.ts";
import { DATA_TABLE } from "./db.ts";
import { applyGivens } from "./sandbox.ts";
import { type Given, loadScenarios, type Moment } from "./scenario.ts";
import { memorySecrets } from "./secret.ts";
import { DATA_VENDOR, errorMessage } from "./shared.ts";

/*
 * A demo: a company repo run on its connectors' fakes, with the world its scenarios describe.
 * Re-exported from `@sanoma-ai/workflows/scenarios`, server-side, since it loads Cucumber.
 */

/** What the last `reseed` of an instance did: what the demo's banner shows. */
export interface DemoState {
  /** When it was seeded, as an ISO timestamp. */
  seededAt: string;
  /** The worlds applied, by scenario name. */
  worlds: string[];
  /** Each moment started and left waiting: who it is for, where they land, its scenario and its run. */
  moments: (Moment & { scenario: string; runId: string })[];
  /** What could not be done, one line each: a feature file that did not load, a world or a moment that failed. */
  problems: string[];
}

/** Each instance's last reseed, by its resolution. */
const states = new WeakMap<ResolvedConfig, DemoState>();

/**
 * A half of a demo's seed (`reseed`'s `only`): what goes into its `database` (the runs cancelled,
 * `sanoma_data` emptied, the worlds' collection records, the moments' runs), or into its `memory`
 * (the instance's fakes reset, the worlds' vendor objects and calls). A copy of a seeded database
 * holds the first half but not the second, which a process over it applies to its own fakes.
 */
export type SeedHalf = "database" | "memory";

/** Which half a world's `Given` goes to: a collection's operation the database, anything else memory; a fault both, each refusing it. */
const halfOf = (g: Given, resolved: ResolvedConfig): SeedHalf | undefined =>
  "fault" in g ? undefined : "op" in g && resolved.ops.get(g.op)?.vendor === DATA_VENDOR ? "database" : "memory";

/**
 * Seeds the demo instance afresh: cancels the app's unfinished runs (`cancelUnfinished`: the last
 * seed's moments among them), empties the collections' table, resets the instance's fakes,
 * applies every world (a scenario with no `When`) to the instance (`applyGivens`: its records
 * saved through the collections' driver, its vendor objects put in the fakes), then starts each
 * moment as a sandbox run by its person, left undriven, so its first approval waits for them.
 * `only` seeds one half (`SeedHalf`). `resolved` is the resolution the worker and `client` run
 * on, made with `fakes: "instance"`. A world or a moment that fails is a problem in the state it
 * returns, and the rest go on.
 */
export async function reseed(
  client: SanomaClient,
  resolved: ResolvedConfig,
  { only }: { only?: SeedHalf } = {},
): Promise<DemoState> {
  const fakes = resolved.instanceFakes;
  if (!fakes) throw new Error('reseed seeds an instance on fakes: resolve its config with `fakes: "instance"`');
  const into = (half: SeedHalf) => only === undefined || only === half;
  // Read first, so scenarios that cannot be read at all leave the instance as it was.
  const { scenarios, errors } = await loadScenarios(resolved);
  if (into("database")) {
    // The last seed's moments, and whatever a visitor started since, end here: nothing is kept.
    await client.cancelUnfinished();
    if (resolved.dataStore) await (await resolved.dataStore.db()).query(`TRUNCATE ${DATA_TABLE}`);
  }
  if (into("memory")) for (const fake of fakes.values()) fake.reset();
  const state: DemoState = {
    seededAt: new Date().toISOString(),
    worlds: [],
    moments: [],
    problems: errors.map((e) => e.message),
  };
  const secrets = memorySecrets();
  for (const world of scenarios.filter((s) => s.workflow === undefined)) {
    // Each Given keeps its place in the world, so its call's idempotency key is the same in either half.
    const kept = [...world.given.entries()].filter(([, g]) => {
      const half = halfOf(g, resolved);
      return half === undefined || into(half);
    });
    try {
      await applyGivens(
        { name: world.name, given: kept.map(([, g]) => g) },
        {
          kind: "instance",
          drivers: resolved.drivers,
          fakes,
          ops: resolved.ops,
          call: (i, opId) => ({
            idempotencyKey: `world:${world.name}:${kept[i]![0]}`,
            runId: `world:${world.name}`,
            opId,
            attempt: 1,
            secrets,
            // Who its records are by: whoever it says is acting, else the runtime's own agent.
            by: world.startedBy ?? "scenarios",
          }),
        },
      );
      state.worlds.push(world.name);
    } catch (err) {
      state.problems.push(`world "${world.name}": ${errorMessage(err)}`);
    }
  }
  for (const s of into("database") ? scenarios : []) {
    if (!s.moment || s.workflow === undefined) continue;
    try {
      const runId = await client.start(s.workflow, s.input, { sandbox: s.name, startedBy: s.moment.person });
      state.moments.push({ ...s.moment, scenario: s.name, runId });
    } catch (err) {
      state.problems.push(`moment "${s.name}": ${errorMessage(err)}`);
    }
  }
  states.set(resolved, state);
  return state;
}

/** What the instance's last `reseed` did, or undefined before its first. */
export const demoState = (resolved: ResolvedConfig): DemoState | undefined => states.get(resolved);
