import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SanomaConfig } from "@sanoma/workflows";
import { describeConfig } from "@sanoma/workflows/describe";
import { problemLine } from "@sanoma/workflows/shared";
import { runScenarios } from "@sanoma/workflows/scenarios";
import type { Loaded } from "./config.ts";

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
const LINTED = ["workflows", "policies", "resources"];

/**
 * Checks a repo the way its tests would, without a test framework: `tsc -p tsconfig.json` in
 * its root; oxlint in the root, with the repo's `.oxlintrc.json` (written when missing, to extend
 * this package's `oxlint.json`), over `workflows/`, `policies/` and `resources/`; every problem
 * `describeConfig` finds in the data files and the workflows' files (the import rules and what
 * the outline cannot draw: what the worker refuses to start with); these three at once, their
 * problems in that order. Then every scenario against the fakes (`runScenarios`), each step that
 * did not hold a problem. `ok` when there are no problems.
 */
export async function check(
  { config, root, resolved }: Loaded,
  { databaseUrl, ready = Promise.resolve(), log }: CheckOptions,
): Promise<CheckResult> {
  // Awaited below when there are scenarios; otherwise its failure is nobody's.
  ready.catch(() => {});
  const found = await Promise.all([typecheck(root, log), lint(root, log), configProblems(config, root, log)]);
  const problems = found.flat();

  if (resolved.scenarios === undefined) {
    log("no scenarios: the config's root has no `scenarios/` directory");
  } else {
    await ready;
    log("scenarios");
    const { failed } = await runScenarios(config, { databaseUrl, log });
    for (const f of failed) problems.push(`${f.scenario} › ${f.step}: ${f.message}`);
  }
  return { ok: problems.length === 0, problems };
}

/** `tsc -p tsconfig.json` in the root. */
async function typecheck(root: string, log: (line: string) => void): Promise<string[]> {
  log("tsc");
  const tsc = await run(binOf("typescript"), ["-p", "tsconfig.json", "--pretty", "false"], root);
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
 * root. A file defining several workflows gives each its problems: one line each here.
 */
async function configProblems(config: SanomaConfig, root: string, log: (line: string) => void): Promise<string[]> {
  log("config");
  const { problems, workflows } = describeConfig(config);
  const lines = new Set([
    ...problems.map(problemLine),
    ...workflows.flatMap((wf) => wf.problems.map((p) => problemLine({ file: relative(root, wf.file), ...p }))),
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
