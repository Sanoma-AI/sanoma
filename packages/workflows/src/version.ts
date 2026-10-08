import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { jsonSchemaOf, type Use, type WorkflowDefinition } from "./define.ts";
import { isOp } from "./op.ts";

/** This package's version. A unit test keeps it equal to package.json. */
export const RUNTIME_VERSION = "0.1.0";

/**
 * The sequence of DBOS calls the runtime makes around each `ctx` call: policy step, approval
 * events and messages, the driver step. Bump it whenever that sequence changes, even without a
 * package release, so a run in flight on the old layout is not replayed against the new one.
 * 2: calls run in program order; a decision event per approval (2026-10-07).
 */
export const STEP_LAYOUT = 2;

let dbosVersion: string | undefined;

/** The installed DBOS SDK's version, read from its package.json (which its exports don't expose). */
function installedDbosVersion(): string {
  if (dbosVersion) return dbosVersion;
  let dir = dirname(createRequire(import.meta.url).resolve("@dbos-inc/dbos-sdk"));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "@dbos-inc/dbos-sdk" && pkg.version) return (dbosVersion = pkg.version);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const up = dirname(dir);
    if (up === dir) throw new Error("Cannot find the package.json of @dbos-inc/dbos-sdk");
    dir = up;
  }
}

/**
 * The application version DBOS stamps on every run, always `<appName>@…`: DBOS version names
 * are unique per system database across apps. A worker recovers and dequeues only runs of its
 * own version, so the version must change whenever replaying an old run on the new code could
 * go wrong. Without `config.version`, it is a hash of the app name, this runtime's and DBOS's
 * versions, and each workflow's name, body and operations; drivers and policy are not in it.
 */
export function computeVersion(config: {
  appName?: string;
  version?: string;
  workflows: readonly WorkflowDefinition<any, any>[];
}): string {
  const appName = config.appName ?? "sanoma";
  if (config.version !== undefined) return `${appName}@${config.version}`;
  const workflows = config.workflows
    .map(
      (wf) =>
        [
          wf.name,
          wf.run.toString(),
          (wf.uses as readonly Use[]).filter(isOp).map((op) => op.id),
          // The input schema is parsed outside steps on replay, so a change to it must change the version.
          inputSchemaOf(wf),
        ] as const,
    )
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash("sha256")
    .update(JSON.stringify([appName, RUNTIME_VERSION, STEP_LAYOUT, installedDbosVersion(), ...workflows]))
    .digest("hex");
  return `${appName}@${hash}`;
}

/*
 * What the hash covers: each workflow's name, the source text of its `run` function, the ids
 * of the operations it uses, and its input schema. What it cannot cover: functions `run` calls
 * that live elsewhere (their source is not reachable from the definition), op schemas, drivers
 * and the policy. A project that edits such helpers between deploys should set `version` in
 * the config (a git commit) instead of relying on the hash.
 */
function inputSchemaOf(wf: WorkflowDefinition<any, any>): unknown {
  try {
    return jsonSchemaOf(wf.input);
  } catch {
    return String(wf.input);
  }
}
