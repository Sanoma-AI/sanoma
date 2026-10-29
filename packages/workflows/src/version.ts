import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { jsonSchemaOf, opIdsOf, type WorkflowDefinition } from "./define.ts";
import { upFrom } from "./paths.ts";

/** This package's version, from its package.json: one level above `src/` and `dist/` alike. */
export const RUNTIME_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/**
 * The sequence of DBOS calls the runtime makes around each `ctx` call: policy step, approval
 * events and messages, the driver step. Bump it whenever that sequence changes, even without a
 * package release, so a run in flight on the old layout is not replayed against the new one.
 * 2: calls run in program order; a decision event per approval (2026-10-07).
 * 3: a start the policy holds waits on its approval before the body (2026-10-21).
 * 4: a sleep for a duration reads DBOS's clock for its start (2026-10-25).
 * 5: a scheduled run admits its starter and asks the policy in two steps before the body (2026-10-25).
 * 6: pin a named connection before policy and recheck its binding before use (2026-10-29).
 */
export const STEP_LAYOUT = 6;

let dbosVersion: string | undefined;

/** The installed DBOS SDK's version, read from its package.json (which its exports don't expose). */
function installedDbosVersion(): string {
  dbosVersion ??= upFrom(dirname(createRequire(import.meta.url).resolve("@dbos-inc/dbos-sdk")), (dir) => {
    let pkg: { name?: string; version?: string };
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as typeof pkg;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    return pkg.name === "@dbos-inc/dbos-sdk" && pkg.version ? pkg.version : undefined;
  });
  if (!dbosVersion) throw new Error("Cannot find the package.json of @dbos-inc/dbos-sdk");
  return dbosVersion;
}

/**
 * The application version DBOS stamps on every run, always `<appName>@…`: DBOS version names
 * are unique per system database across apps. A worker recovers and dequeues only runs of its
 * own version, so the version must change whenever replaying an old run on the new code could
 * go wrong.
 *
 * It is a hash of the app name, `RUNTIME_VERSION`, `STEP_LAYOUT`, the installed DBOS version,
 * and for each workflow its name, the source text of its `run` function, the ids of the
 * operations it uses and its input schema as JSON Schema: DBOS's own automatic versioning, over
 * the workflow code instead of the runtime's one registration wrapper. The hash cannot see
 * functions `run` calls that live elsewhere (their source is not reachable from the definition),
 * op schemas, drivers or the policy. DBOS's `DBOS__APPVERSION` environment variable names a
 * version instead (a git commit, say), still prefixed with the app name.
 */
export function computeVersion({
  appName,
  workflows: definitions,
}: {
  /** The resolved config's `appName`. */
  appName: string;
  workflows: readonly WorkflowDefinition<any, any>[];
}): string {
  const named = process.env.DBOS__APPVERSION?.trim();
  if (named) return `${appName}@${named}`;
  const workflows = definitions.map(codeOf).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${appName}@${sha256([appName, RUNTIME_VERSION, STEP_LAYOUT, installedDbosVersion(), ...workflows])}`;
}

/**
 * A hash of the built-in `change` workflow's own code, which each change run carries (its
 * `changeCode` attribute) so a worker on another version of the app may take it over
 * (`carryChangeRuns` in worker.ts): what `computeVersion` hashes of that one workflow, with
 * `RUNTIME_VERSION`, `STEP_LAYOUT` and the installed DBOS version. Never the company's workflows
 * nor `DBOS__APPVERSION`, so a merge that changes only the company's code leaves it as it is.
 */
export function changeCodeOf(change: WorkflowDefinition<any, any>): string {
  return sha256([RUNTIME_VERSION, STEP_LAYOUT, installedDbosVersion(), codeOf(change)]);
}

const sha256 = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** What the hashes read of a workflow: its name, the source of its `run`, its operations and its input schema. */
const codeOf = (wf: WorkflowDefinition<any, any>) =>
  [
    wf.name,
    wf.run.toString(),
    opIdsOf(wf),
    // The input schema is parsed outside steps on replay, so a change to it must change the version.
    inputSchemaOf(wf),
  ] as const;

/** The workflow's input schema as the hash sees it: its JSON Schema, or its text when zod can't convert it. */
function inputSchemaOf(wf: WorkflowDefinition<any, any>): unknown {
  try {
    return jsonSchemaOf(wf.input);
  } catch {
    return String(wf.input);
  }
}
