#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkRepo, declared, isCheckout, leftoverLinks, linkSet, notLinked, UsageError } from "./links.ts";

const USAGE = `usage: sanoma-dev <command>

Develops sanoma from the Sanoma repo in the working directory (the one holding sanoma.config.ts).

  sanoma-dev link [<checkout>]   install and build a sanoma checkout (default ../sanoma beside the repo), then
                                 pnpm link from it, one by one and checked, sanoma and each @sanoma-ai package the
                                 repo declares; \`pnpm dev\` then runs the checkout in dev mode
  sanoma-dev unlink              undo the link, and fail when package.json or pnpm-workspace.yaml still hold a link:
  sanoma-dev update              pnpm update --latest sanoma and @sanoma-ai/*, then sanoma check; refused while linked

link and unlink remove the repo's .sanoma/app before pnpm links or unlinks: the sanoma that ran before
generated all of it.`;

/** Exit codes: 2 for how the bin was called or what it found, 1 for a failure while running. */
const USAGE_EXIT = 2;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs pnpm in `cwd`, its output passed through; its exit code (1 for a signal). Throws when pnpm cannot start. */
function pnpm(cwd: string, args: string[]): number {
  const { status, error } = spawnSync("pnpm", args, { cwd, stdio: "inherit" });
  if (error) throw new Error(`could not run pnpm: ${error.message}`);
  return status ?? 1;
}

const mustPnpm = (cwd: string, args: string[]) => {
  if (pnpm(cwd, args) !== 0) throw new Error(`pnpm ${args.join(" ")} failed in ${cwd}`);
};

const COMMANDS = ["link", "unlink", "update"];

/** Removes the repo's `.sanoma/app`, saying so: see the README's Generated files. */
function clearGenerated(root: string): void {
  const app = join(root, ".sanoma", "app");
  if (!existsSync(app)) return;
  rmSync(app, { recursive: true, force: true });
  console.log("removed .sanoma/app");
}

/** Runs the command line in the working directory; returns the exit code. */
function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { help: { type: "boolean", short: "h" } } });
  } catch (err) {
    throw new UsageError(`${messageOf(err)}\n\n${USAGE}`);
  }
  if (parsed.values.help) {
    console.log(USAGE);
    return 0;
  }
  const [command, ...rest] = parsed.positionals;
  if (command === undefined) throw new UsageError(USAGE);
  if (!COMMANDS.includes(command)) throw new UsageError(`unknown command "${command}"\n\n${USAGE}`);
  if (rest.length > (command === "link" ? 1 : 0)) throw new UsageError(`too many arguments\n\n${USAGE}`);
  const cwd = process.cwd();
  checkRepo(cwd);
  if (command === "unlink") return unlink(cwd);
  if (command === "update") return update(cwd);
  return link(cwd, rest[0] === undefined ? undefined : resolve(cwd, rest[0]));
}

function link(root: string, given: string | undefined): number {
  const checkout = given ?? resolve(root, "../sanoma");
  if (!isCheckout(checkout)) throw new UsageError(`${checkout} is not a sanoma checkout (no packages/sanoma)`);
  const { found, missing } = linkSet(root, checkout);
  if (missing.length) console.log(`not in ${checkout}, so not linked: ${missing.join(", ")}`);
  if (!found.length) throw new UsageError("nothing to link: package.json declares no sanoma package the checkout has");
  console.log(`building ${checkout} (about a minute)`);
  mustPnpm(checkout, ["install", "--frozen-lockfile"]);
  mustPnpm(checkout, ["build"]);
  clearGenerated(root);
  // One directory per pnpm link: one call with several can leave some unlinked, and still exit 0 (#255).
  // The check below, not pnpm's exit code, decides, so a failure part way still points to unlink.
  for (const p of found) pnpm(root, ["link", p.dir]);
  for (const p of notLinked(root, found)) pnpm(root, ["link", p.dir]);
  const failed = notLinked(root, found);
  if (failed.length) {
    throw new Error(
      `not linked: ${failed.map((p) => p.name).join(", ")}: pnpm-workspace.yaml has no link: override for it, ` +
        "or node_modules/<name> is not its directory in the checkout; sanoma-dev unlink undoes the links that took",
    );
  }
  console.log(`linked ${found.map((p) => p.name).join(", ")} from ${checkout}`);
  console.log("pnpm dev now runs the checkout in dev mode; sanoma-dev unlink before you commit");
  return 0;
}

function unlink(root: string): number {
  const names = declared(root);
  clearGenerated(root);
  if (names.length) mustPnpm(root, ["unlink", ...names]);
  const left = leftoverLinks(root);
  if (left.length) throw new Error(`still linked, do not commit:\n${left.join("\n")}`);
  console.log(`unlinked ${names.join(", ") || "nothing"}: package.json and pnpm-workspace.yaml hold no link:`);
  console.log("commit once git status shows only your own changes");
  return 0;
}

function update(root: string): number {
  const left = leftoverLinks(root);
  if (left.length) throw new UsageError(`linked to a checkout: run sanoma-dev unlink first\n${left.join("\n")}`);
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
