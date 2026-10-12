import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { problemAt } from "@sanoma/workflows";
import { describeConfig } from "@sanoma/workflows/describe";
import { runScenarios } from "@sanoma/workflows/scenarios";
import type { LoadedConfig } from "./config.ts";

export interface CheckResult {
  ok: boolean;
  /** One printable line each: `<file>:<line>:<col>: <message>`, or `<scenario> › <step>: <message>`. */
  problems: string[];
}

export interface CheckOptions {
  /** The Postgres the scenarios' worker runs on: a database of its own, never the config's. Needed unless `scenarios` is false. */
  databaseUrl?: string;
  /** Whether to run the scenarios. Default true. */
  scenarios?: boolean;
  log: (line: string) => void;
}

/** The directories oxlint reads, those that exist. */
const LINTED = ["workflows", "policies", "resources"];

/**
 * Checks a repo the way its tests would, without a test framework: `tsc -p tsconfig.json` in
 * its root; oxlint in the root, with the repo's `.oxlintrc.json` (written when missing, to extend
 * this package's `oxlint.json`), over `workflows/`, `policies/` and `resources/`; every problem `describeConfig` finds
 * in the data files and the workflows' files (the import rules and what the outline cannot
 * draw: what the worker refuses to start with); then every scenario against the fakes
 * (`runScenarios`), each step that did not hold a problem. `ok` when there are no problems.
 */
export async function check(
  loaded: LoadedConfig,
  { databaseUrl, scenarios = true, log }: CheckOptions,
): Promise<CheckResult> {
  const { config, root } = loaded;
  const problems: string[] = [];
  const at = (file: string) =>
    isAbsolute(file) && !relative(root, file).startsWith("..") ? relative(root, file) : file;

  log("tsc");
  const tsc = await run(binOf("typescript"), ["-p", "tsconfig.json", "--pretty", "false"], root);
  if (tsc.code !== 0) problems.push(...tscProblems(tsc));

  const dirs = LINTED.filter((dir) => existsSync(join(root, dir)));
  if (dirs.length) {
    if (writeOxlintrc(root)) log("wrote .oxlintrc.json");
    log(`oxlint ${dirs.join(" ")}`);
    const args = ["--deny-warnings", "-f", "json", ...dirs];
    problems.push(...oxlintProblems(await run(binOf("oxlint"), args, root)));
  }

  log("config");
  for (const p of describeConfig(config).problems) {
    const where = problemAt(p);
    problems.push(where === undefined ? p.message : `${at(p.file!)}:${p.line}:${p.column}: ${p.message}`);
  }

  if (!scenarios) {
    log("scenarios skipped");
  } else if (config.scenarios === undefined) {
    log("no scenarios: the config has no `scenarios` directory");
  } else {
    if (databaseUrl === undefined) throw new Error("check needs a databaseUrl to run the scenarios on");
    log("scenarios");
    const { failed } = await runScenarios(config, { databaseUrl, log });
    for (const f of failed) problems.push(`${f.scenario} › ${f.step}: ${f.message}`);
  }
  return { ok: problems.length === 0, problems };
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
