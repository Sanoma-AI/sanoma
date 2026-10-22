import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { declared, dirIn, leftoverLinks, linkSet } from "../src/links.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const manifest = (at: string, json: object) => write(join(at, "package.json"), JSON.stringify(json));

/**
 * A temporary directory with a Sanoma repo in `repo/` declaring `dependencies` and `devDependencies`,
 * and a sanoma checkout in `sanoma/` (its default place) holding `sanoma` and the packages named.
 */
function layout({
  dependencies = {},
  devDependencies = {},
  packages = [],
}: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packages?: string[];
}) {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-dev-kit-")));
  const repo = join(dir, "repo");
  const checkout = join(dir, "sanoma");
  manifest(repo, { name: "company", dependencies, devDependencies });
  write(join(repo, "sanoma.config.ts"), "");
  for (const name of ["sanoma", ...packages]) manifest(dirIn(checkout, name), { name });
  return { repo, checkout };
}

describe("declared and linkSet", () => {
  it("are sanoma and the declared @sanoma-ai packages but this one, split by whether the checkout has them", () => {
    const { repo, checkout } = layout({
      dependencies: {
        sanoma: "^0.4.2",
        "@sanoma-ai/connector-ghost": "^0.4.2",
        "@sanoma-ai/connector-acme": "^1.0.0",
        zod: "^4",
      },
      devDependencies: { "@sanoma-ai/dev": "^0.4.2", "@sanoma-ai/testing": "^0.4.2" },
      packages: ["@sanoma-ai/connector-ghost", "@sanoma-ai/testing", "@sanoma-ai/workflows"],
    });
    expect(declared(repo)).toEqual([
      "sanoma",
      "@sanoma-ai/connector-ghost",
      "@sanoma-ai/connector-acme",
      "@sanoma-ai/testing",
    ]);
    expect(linkSet(repo, checkout)).toEqual({
      found: [
        { name: "sanoma", dir: join(checkout, "packages/sanoma") },
        { name: "@sanoma-ai/connector-ghost", dir: join(checkout, "connectors/ghost") },
        { name: "@sanoma-ai/testing", dir: join(checkout, "packages/testing") },
      ],
      missing: ["@sanoma-ai/connector-acme"],
    });
  });
});

describe("leftoverLinks", () => {
  it("names each link: of a sanoma package in package.json and the workspace, not the repo's own links", () => {
    const { repo } = layout({ dependencies: { sanoma: "^0.4.2" } });
    write(join(repo, "pnpm-workspace.yaml"), "minimumReleaseAgeExclude:\n  - sanoma\n");
    expect(leftoverLinks(repo)).toEqual([]);

    manifest(repo, {
      dependencies: { sanoma: "^0.4.2", mine: "link:./lib" },
      devDependencies: { "@sanoma-ai/testing": "link:../sanoma/packages/testing" },
    });
    write(
      join(repo, "pnpm-workspace.yaml"),
      "overrides:\n  mine: link:./lib\n  sanoma: link:../sanoma/packages/sanoma\n  '@sanoma-ai/connector-ghost': link:../sanoma/connectors/ghost\n",
    );
    expect(leftoverLinks(repo)).toEqual([
      'package.json: "@sanoma-ai/testing": "link:../sanoma/packages/testing"',
      "pnpm-workspace.yaml: sanoma: link:../sanoma/packages/sanoma",
      "pnpm-workspace.yaml: '@sanoma-ai/connector-ghost': link:../sanoma/connectors/ghost",
    ]);
  });
});

/**
 * Runs the bin in `cwd` with a `pnpm` on PATH that records each of this run's calls, directory and arguments,
 * and exits 3 for `pnpm exec` (a failing `sanoma check`).
 */
function sanomaDev(cwd: string, args: string[]) {
  const calls = join(dir, "pnpm-calls");
  const bin = join(dir, "bin");
  write(join(bin, "pnpm"), `#!/bin/sh\necho "$(pwd -P) $*" >> "${calls}"\n[ "$1" = exec ] && exit 3\nexit 0\n`);
  chmodSync(join(bin, "pnpm"), 0o755);
  rmSync(calls, { force: true });
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
  });
  const recorded = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, calls: recorded };
}

describe("sanoma-dev", () => {
  it("link builds a checkout with no build, then links what the repo declares and the checkout has, in one pnpm link", () => {
    const { repo, checkout } = layout({
      dependencies: { sanoma: "^0.4.2", "@sanoma-ai/connector-ghost": "^0.4.2", "@sanoma-ai/connector-acme": "^1.0.0" },
      devDependencies: { "@sanoma-ai/dev": "^0.4.2" },
      packages: ["@sanoma-ai/connector-ghost"],
    });
    const { status, stdout, calls } = sanomaDev(repo, ["link"]);
    expect(status).toBe(0);
    expect(calls).toEqual([
      `${checkout} install --frozen-lockfile`,
      `${checkout} build`,
      `${repo} link ${join(checkout, "packages/sanoma")} ${join(checkout, "connectors/ghost")}`,
    ]);
    expect(stdout).toContain(`not in ${checkout}, so not linked: @sanoma-ai/connector-acme`);
    expect(stdout).toContain(`linked sanoma, @sanoma-ai/connector-ghost from ${checkout}`);
  });

  it("link skips the build when there is one, and takes a checkout's path", () => {
    const { repo, checkout } = layout({ dependencies: { sanoma: "^0.4.2" } });
    mkdirSync(join(checkout, "packages/sanoma/dist"));
    const { status, calls } = sanomaDev(repo, ["link", "../sanoma"]);
    expect(status).toBe(0);
    expect(calls).toEqual([`${repo} link ${join(checkout, "packages/sanoma")}`]);
  });

  it("refuses what is not a checkout, a directory with no sanoma.config.ts, and extra arguments, with exit 2", () => {
    const { repo } = layout({ dependencies: { sanoma: "^0.4.2" } });
    const notCheckout = sanomaDev(repo, ["link", "."]);
    expect([notCheckout.status, notCheckout.stderr]).toEqual([
      2,
      `${repo} is not a sanoma checkout (no packages/sanoma)\n`,
    ]);
    expect(sanomaDev(dir, ["unlink"]).status).toBe(2);
    expect(sanomaDev(repo, ["update", "now"]).status).toBe(2);
    expect(sanomaDev(repo, []).calls).toEqual([]);
  });

  it("unlink unlinks the declared set and fails while a link: is left; update refuses while linked, then passes check's exit code", () => {
    const { repo } = layout({ dependencies: { sanoma: "^0.4.2" }, devDependencies: { "@sanoma-ai/dev": "^0.4.2" } });
    write(join(repo, "pnpm-workspace.yaml"), "overrides:\n  sanoma: link:../sanoma/packages/sanoma\n");
    const left = sanomaDev(repo, ["unlink"]);
    expect(left.status).toBe(1);
    expect(left.calls).toEqual([`${repo} unlink sanoma`]);
    expect(left.stderr).toContain("pnpm-workspace.yaml: sanoma: link:../sanoma/packages/sanoma");

    const refused = sanomaDev(repo, ["update"]);
    expect(refused.status).toBe(1);
    expect(refused.calls).toEqual([]);

    write(join(repo, "pnpm-workspace.yaml"), "");
    expect(sanomaDev(repo, ["unlink"]).status).toBe(0);
    const updated = sanomaDev(repo, ["update"]);
    expect(updated.status).toBe(3);
    expect(updated.calls).toEqual([`${repo} update --latest sanoma @sanoma-ai/*`, `${repo} exec sanoma check`]);
  });
});
