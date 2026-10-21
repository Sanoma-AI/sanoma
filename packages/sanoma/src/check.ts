import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { errorMessage } from "@sanoma-ai/workflows";
import {
  type ConfigDescription,
  describeConfig,
  NO_PEOPLE,
  schemaOf,
  writeGenerated,
} from "@sanoma-ai/workflows/describe";
import { problemLine } from "@sanoma-ai/workflows/shared";
import { runScenarios } from "@sanoma-ai/workflows/scenarios";
import type { Loaded } from "./config.ts";
import { usePolicies } from "./policies.ts";
import { runtimeFrom, siteBuild } from "./sites.ts";

export interface CheckResult {
  ok: boolean;
  /** One printable line each: `<file>:<line>:<col>: <message>`, or `<scenario> › <step>: <message>`. */
  problems: string[];
}

export interface CheckOptions {
  /** The Postgres the scenarios' worker runs on: a database of its own, never the config's. */
  databaseUrl: string;
  /**
   * Settles once Postgres answers at `databaseUrl`'s server (the bin's `ensurePostgres`, started
   * before `check`): awaited only before the scenarios, so tsc, oxlint and the config's reading
   * do not wait on it. A failure is the check's only when there are scenarios to run.
   */
  ready?: Promise<unknown>;
  log: (line: string) => void;
}

/** The directories oxlint reads, those that exist. */
const LINTED = ["workflows", "policies", "resources", "sites"];

/**
 * Checks a repo the way its tests would, without a test framework: its policy made from
 * `policies/*.cedar` when the config names none (`usePolicies`, whose problems are the check's);
 * the generated files written first (`writeGenerated`: `.sanoma/api.ts` and the Cedar schema,
 * each when it changed); `tsc -p tsconfig.json` in
 * its root; oxlint in the root, with the repo's `.oxlintrc.json` (written when missing, to extend
 * this package's `oxlint.json`), over `workflows/`, `policies/`, `resources/` and `sites/`; every problem
 * `describeConfig` finds in the data files and the workflows' files (the import rules and what
 * the outline cannot draw: what the worker refuses to start with), and each site's call to what
 * the config does not have; with sites, their generated files written first and, beside those
 * three, the app built with them and `tsc -p sites/tsconfig.json` (`checkSites`). Their problems
 * in the order tsc, the sites' tsc, oxlint, the policies, the config, the folders refused as
 * sites, the sites' build. Then, unless the policies do not hold, every scenario against the fakes (`runScenarios`), each step that did not hold a
 * problem. `ok` when there are no problems.
 */
export async function check(
  { config, root, resolved }: Loaded,
  { databaseUrl, ready = Promise.resolve(), log }: CheckOptions,
): Promise<CheckResult> {
  // Awaited below when there are scenarios; otherwise its failure is nobody's.
  ready.catch(() => {});
  log("config");
  const policies = await usePolicies({ config, root }, NO_PEOPLE);
  const description = describeConfig(config);
  const { wrote } = await writeGenerated(root, description, schemaOf(resolved, NO_PEOPLE));
  for (const file of wrote) log(`wrote ${file}`);
  const build = await siteBuild(root);
  const { sites, refused } = build?.sitesOf(root) ?? { sites: [], refused: [] };
  // Before tsc and oxlint read sites/, as `sanoma` writes them: only when there is a site.
  if (build && sites.length) build.writeSiteFiles(root);
  const [tsc, checked, lints] = await Promise.all([
    typecheck(root, log),
    build && sites.length ? checkSites(build, sites, root, log) : { typed: [], built: [] },
    lint(root, log),
  ]);
  const read = configProblems(description, root);
  const unmounted = refused.map(
    (name) => `sites/${name}: a site's folder name is a URL segment (lowercase letters, digits and dashes)`,
  );
  const problems = [...tsc, ...checked.typed, ...lints, ...policies, ...read, ...unmounted, ...checked.built];

  if (resolved.scenarios === undefined) {
    log("no scenarios: the config's root has no `scenarios/` directory");
  } else if (policies.length) {
    log("no scenarios: the policies do not hold");
  } else {
    await ready;
    log("scenarios");
    const { failed } = await runScenarios(config, { databaseUrl, log });
    for (const f of failed) problems.push(`${f.scenario} › ${f.step}: ${f.message}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The sites: the app built with them (`buildApp`, reused when nothing changed), so two pages
 * claiming one path or a site importing server code is a problem; then `tsc -p
 * sites/tsconfig.json`, which needs the route tree the build generates (it gives every `Link` its
 * type), so it runs once there is one.
 */
async function checkSites(
  build: typeof import("@sanoma-ai/app/build"),
  sites: string[],
  root: string,
  log: (line: string) => void,
): Promise<{ typed: string[]; built: string[] }> {
  log(`build ${sites.join(" ")}`);
  const built = await build.buildApp(root, { runtimeFrom: runtimeFrom() }).then(
    () => [],
    (err: unknown) => buildProblems(errorMessage(err), log),
  );
  if (!existsSync(join(root, ".sanoma", "app", "routeTree.gen.ts"))) return { typed: [], built };
  return { typed: await typecheck(root, log, "sites/tsconfig.json"), built };
}

/**
 * A failed build's problems, one line each: every import the browser may not make, at its
 * importer's `file:line:col`; anything else as its first line, the whole message logged.
 */
function buildProblems(message: string, log: (line: string) => void): string[] {
  const denied = [
    ...message.matchAll(/Import denied in client environment[\s\S]*?Importer: (\S+)[\s\S]*?Import: ("[^"\n]*")/g),
  ];
  if (denied.length) return denied.map(([, at, what]) => `${at}: Import denied in client environment: ${what}`);
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^Build failed with \d+ errors?:$/.test(line));
  if (lines.length > 1) log(message);
  return [lines[0] ?? "the app's build failed"];
}

/** `tsc -p <project>` in the root (`tsconfig.json`, or the sites' `sites/tsconfig.json`). */
async function typecheck(root: string, log: (line: string) => void, project = "tsconfig.json"): Promise<string[]> {
  log(project === "tsconfig.json" ? "tsc" : `tsc ${project}`);
  const tsc = await run(binOf("typescript"), ["-p", project, "--pretty", "false"], root);
  return tsc.code === 0 ? [] : tscProblems(tsc);
}

/** oxlint in the root, on its `.oxlintrc.json` (written when missing), over the directories that exist. */
async function lint(root: string, log: (line: string) => void): Promise<string[]> {
  const dirs = LINTED.filter((dir) => existsSync(join(root, dir)));
  if (!dirs.length) return [];
  if (writeOxlintrc(root)) log("wrote .oxlintrc.json");
  log(`oxlint ${dirs.join(" ")}`);
  return oxlintProblems(await run(binOf("oxlint"), ["--deny-warnings", "-f", "json", ...dirs], root));
}

/**
 * `describeConfig`'s problems: the data files', then each workflow's, its file relative to the
 * root, then each site's (a call to what the config does not have). A file defining several
 * workflows gives each its problems: one line each here.
 */
function configProblems({ problems, workflows, sites }: ConfigDescription, root: string): string[] {
  const lines = new Set([
    ...problems.map(problemLine),
    ...workflows.flatMap((wf) => wf.problems.map((p) => problemLine({ file: relative(root, wf.file), ...p }))),
    ...sites.flatMap((site) => site.problems.map(problemLine)),
  ]);
  return [...lines];
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a JavaScript bin with this Node, in `cwd`; never throws for its exit code. */
async function run(bin: string, args: string[], cwd: string): Promise<Ran> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [bin, ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const { code, stdout, stderr } = err as { code?: number | string; stdout?: string; stderr?: string };
    if (typeof code !== "number") throw err;
    return { code, stdout: stdout ?? "", stderr: stderr ?? "" };
  }
}

/** A package's bin (its only one), found from this package by its `package.json`: neither `typescript` nor `oxlint` exports it. */
function binOf(pkg: string): string {
  const manifest = new URL(import.meta.resolve(`${pkg}/package.json`));
  const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin: string | Record<string, string> };
  return fileURLToPath(new URL(typeof bin === "string" ? bin : Object.values(bin)[0]!, manifest));
}

/**
 * tsc's `--pretty false` lines, `file(line,col): error TS1234: message`, as `file:line:col: message`;
 * anything else it printed as it is, and its exit code when it printed nothing.
 */
function tscProblems({ code, stdout, stderr }: Ran): string[] {
  const lines = `${stdout}${stderr}`.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [`tsc exited with ${code}`];
  return lines.map((line) => line.replace(/^(.+?)\((\d+),(\d+)\): /, "$1:$2:$3: "));
}

/** The repo's `.oxlintrc.json`: this package's lint, for `sanoma check` and an editor alike. */
const OXLINTRC = `${JSON.stringify({ extends: ["./node_modules/sanoma/oxlint.json"] }, null, 2)}\n`;

/**
 * Writes `<root>/.oxlintrc.json` when there is none, and says whether it did. oxlint, run in the
 * root, reads it and matches the rules' `workflows/**` globs against the root.
 */
function writeOxlintrc(root: string): boolean {
  const file = join(root, ".oxlintrc.json");
  if (existsSync(file)) return false;
  writeFileSync(file, OXLINTRC);
  return true;
}

interface Diagnostic {
  filename: string;
  message: string;
  help?: string;
  labels: { span: { line: number; column: number } }[];
}

/** oxlint's JSON diagnostics as lines; what it printed instead when the output is not JSON (a config it refused). */
function oxlintProblems({ code, stdout, stderr }: Ran): string[] {
  let diagnostics: Diagnostic[];
  try {
    ({ diagnostics } = JSON.parse(stdout) as { diagnostics: Diagnostic[] });
  } catch {
    return code === 0 ? [] : [`oxlint exited with ${code}: ${stderr.trim() || stdout.trim()}`];
  }
  const lines = diagnostics.map(({ filename, message, help, labels }) => {
    const span = labels[0]?.span;
    const where = span ? `${filename}:${span.line}:${span.column}` : filename;
    return `${where}: ${message}${help ? ` ${help}` : ""}`;
  });
  if (code !== 0 && lines.length === 0) lines.push(`oxlint exited with ${code}: ${stderr.trim()}`);
  return lines;
}
