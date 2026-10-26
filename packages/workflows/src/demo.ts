import type { SanomaClient } from "./client.ts";
import type { ResolvedConfig } from "./config.ts";
import { DATA_TABLE } from "./db.ts";
import { applyGivens } from "./sandbox.ts";
import { loadScenarios, type Moment } from "./scenario.ts";
import { memorySecrets } from "./secret.ts";
import { errorMessage } from "./shared.ts";

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
 * Seeds the demo instance afresh: empties the collections' table, resets the instance's fakes,
 * applies every world (a scenario with no `When`) to the instance (`applyGivens`: its records
 * saved through the collections' driver, its vendor objects put in the fakes), then starts each
 * moment as a sandbox run by its person, left undriven, so its first approval waits for them.
 * `resolved` is the resolution the worker and `client` run on, made with `fakes: "instance"`.
 * A world or a moment that fails is a problem in the state it returns, and the rest go on.
 */
export async function reseed(client: SanomaClient, resolved: ResolvedConfig): Promise<DemoState> {
  const fakes = resolved.instanceFakes;
  if (!fakes) throw new Error('reseed seeds an instance on fakes: resolve its config with `fakes: "instance"`');
  // Read first, so scenarios that cannot be read at all leave the instance as it was.
  const { scenarios, errors } = await loadScenarios(resolved);
  if (resolved.dataStore) await (await resolved.dataStore.db()).query(`TRUNCATE ${DATA_TABLE}`);
  for (const fake of fakes.values()) fake.reset();
  const state: DemoState = {
    seededAt: new Date().toISOString(),
    worlds: [],
    moments: [],
    problems: errors.map((e) => e.message),
  };
  const secrets = memorySecrets();
  for (const world of scenarios.filter((s) => s.workflow === undefined)) {
    try {
      await applyGivens(world, {
        kind: "instance",
        drivers: resolved.drivers,
        fakes,
        ops: resolved.ops,
        call: (i, opId) => ({
          idempotencyKey: `world:${world.name}:${i}`,
          runId: `world:${world.name}`,
          opId,
          attempt: 1,
          secrets,
          // Who its records are by: whoever it says is acting, else the runtime's own agent.
          by: world.startedBy ?? "scenarios",
        }),
      });
      state.worlds.push(world.name);
    } catch (err) {
      state.problems.push(`world "${world.name}": ${errorMessage(err)}`);
    }
  }
  for (const s of scenarios) {
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
