#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { declared, isCheckout, leftoverLinks, linkSet, repoRoot, UsageError } from "./links.ts";

const USAGE = `usage: sanoma-dev <command>

Develops sanoma from the Sanoma repo in the working directory (the one holding sanoma.config.ts).

  sanoma-dev link [<checkout>]   pnpm link sanoma and each @sanoma-ai package the repo declares from a sanoma
                                 checkout (default ../sanoma beside the repo), installing and building it first
                                 when it has no build; \`pnpm dev\` then runs the checkout in dev mode
  sanoma-dev unlink              undo the link, and fail when package.json or pnpm-workspace.yaml still hold a link:
  sanoma-dev update              pnpm update --latest sanoma and @sanoma-ai/*, then sanoma check; refused while linked
`;

/** Exit codes: 2 for how the bin was called or what it found, 1 for a failure while running. */
const USAGE_EXIT = 2;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs pnpm in `cwd`, its output passed through; its exit code, or 1 when it could not start. */
function pnpm(cwd: string, args: string[]): number {
  const { status, error } = spawnSync("pnpm", args, { cwd, stdio: "inherit" });
  if (error) throw new Error(`could not run pnpm: ${error.message}`);
  return status ?? 1;
}

const mustPnpm = (cwd: string, args: string[]) => {
  if (pnpm(cwd, args) !== 0) throw new Error(`pnpm ${args.join(" ")} failed in ${cwd}`);
};

/** Runs the command line; returns the exit code. */
export function main(argv: string[], cwd = process.cwd()): number {
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (err) {
    throw new UsageError(`${messageOf(err)}\n\n${USAGE.trimEnd()}`);
  }
  const { positionals, values } = args;
  if (values.help) {
    console.log(USAGE.trimEnd());
    return 0;
  }
  const [command, ...rest] = positionals;
  const extra = (max: number) => {
    if (rest.length > max) throw new UsageError(`too many arguments\n\n${USAGE.trimEnd()}`);
  };
  switch (command) {
    case "link":
      extra(1);
      return link(repoRoot(cwd), rest[0] === undefined ? undefined : resolve(cwd, rest[0]));
    case "unlink":
      extra(0);
      return unlink(repoRoot(cwd));
    case "update":
      extra(0);
      return update(repoRoot(cwd));
    case undefined:
      throw new UsageError(USAGE.trimEnd());
    default:
      throw new UsageError(`unknown command "${command}"\n\n${USAGE.trimEnd()}`);
  }
}

const parse = (argv: string[]) =>
  parseArgs({ args: argv, allowPositionals: true, options: { help: { type: "boolean", short: "h" } } });

function link(root: string, given: string | undefined): number {
  const checkout = given ?? resolve(root, "../sanoma");
  if (!isCheckout(checkout)) throw new UsageError(`${checkout} is not a sanoma checkout (no packages/sanoma)`);
  if (!existsSync(join(checkout, "packages/sanoma/dist"))) {
    console.log(`${checkout} has no build: installing and building it`);
    mustPnpm(checkout, ["install", "--frozen-lockfile"]);
    mustPnpm(checkout, ["build"]);
  }
  const { found, missing } = linkSet(root, checkout);
  if (missing.length) console.log(`not in ${checkout}, so not linked: ${missing.join(", ")}`);
  if (!found.length) throw new Error("nothing to link: package.json declares no sanoma package the checkout has");
  mustPnpm(root, ["link", ...found.map((p) => p.dir)]);
  console.log(`linked ${found.map((p) => p.name).join(", ")} from ${checkout}`);
  console.log("pnpm dev now runs the checkout in dev mode; sanoma-dev unlink before you commit");
  return 0;
}

function unlink(root: string): number {
  const names = declared(root);
  if (names.length) mustPnpm(root, ["unlink", ...names]);
  const left = leftoverLinks(root);
  if (left.length) throw new Error(`still linked, do not commit:\n${left.join("\n")}`);
  console.log(`unlinked ${names.join(", ") || "nothing"}: package.json and pnpm-workspace.yaml hold no link:`);
  console.log("the repo is ready to commit");
  return 0;
}

function update(root: string): number {
  const left = leftoverLinks(root);
  if (left.length) throw new Error(`linked to a checkout: run sanoma-dev unlink first\n${left.join("\n")}`);
  mustPnpm(root, ["update", "--latest", "sanoma", "@sanoma-ai/*"]);
  console.log("updated sanoma and @sanoma-ai/* to their latest releases; running sanoma check");
  const status = pnpm(root, ["exec", "sanoma", "check"]);
  console.log(
    status === 0 ? "sanoma check passed: commit the update" : "sanoma check failed: fix the repo, then commit",
  );
  return status;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(messageOf(err));
    process.exitCode = err instanceof UsageError ? USAGE_EXIT : 1;
  }
}
