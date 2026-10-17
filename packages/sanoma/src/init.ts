import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { parseEnv, promisify } from "node:util";

const run = promisify(execFile);

/** The company template this package ships (`files`): `template/` beside `src/` and `dist/`. */
export const TEMPLATE = new URL("../template/", import.meta.url);

/** The runtime's default database (`resolveDatabaseUrl`), which this module does not load `@sanoma-ai/workflows` for; a test holds them equal. */
export const DATABASE_URL = "postgresql://postgres:dbos@localhost:5433/sanoma";

export const FIRST_COMMIT = "Start a Sanoma company";

export interface StartOptions {
  /** Runs `<packageManager> install` in the directory; the default inherits this process's stdio. */
  install?: (cwd: string, packageManager: string) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * `sanoma` where there is no `sanoma.config.ts`: in an empty directory (dotfiles aside) it starts
 * a company there and says so; anywhere else it does nothing and says it did not. Starting copies
 * the template, names the package after the directory, writes `.env` (the default database and a
 * new `SANOMA_SECRETS_KEY`, keeping what it already holds), installs with the package manager
 * that ran this (`npm_config_user_agent`, else pnpm), and commits everything as the first commit
 * of a git repository, as the machine's git user. Throws before writing anything when git has no
 * user to commit as.
 */
export async function startCompany(
  cwd: string,
  { install = installWith, log = () => {} }: StartOptions = {},
): Promise<boolean> {
  if (readdirSync(cwd).some((name) => !name.startsWith("."))) return false;
  await run("git", ["var", "GIT_AUTHOR_IDENT"]).catch((err: unknown) => {
    throw new Error("git needs a user to commit as: set git config user.name and user.email", { cause: err });
  });
  log(`starting a Sanoma company in ${cwd}`);
  cpSync(TEMPLATE, cwd, { recursive: true, force: false });
  // npm drops a package's .gitignore, so the template carries it as gitignore.
  const [carried, ignore] = [join(cwd, "gitignore"), join(cwd, ".gitignore")];
  if (!existsSync(ignore)) renameSync(carried, ignore);
  else {
    appendFileSync(ignore, `\n${readFileSync(carried, "utf8")}`);
    rmSync(carried);
  }

  const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const manifest = join(cwd, "package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name: string; dependencies: Record<string, string> };
  pkg.name = packageName(basename(cwd));
  // The template's packages at this launcher's version: Sanoma releases them together.
  for (const name of Object.keys(pkg.dependencies)) pkg.dependencies[name] = `^${own.version}`;
  writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);

  writeEnv(join(cwd, ".env"), {
    SANOMA_DATABASE_URL: DATABASE_URL,
    SANOMA_SECRETS_KEY: randomBytes(32).toString("base64"),
  });

  const packageManager = packageManagerOf(process.env.npm_config_user_agent);
  log(`installing with ${packageManager}`);
  await install(cwd, packageManager);

  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd });
  await run("git", ["add", "--all"], { cwd });
  await run("git", ["commit", "--quiet", "-m", FIRST_COMMIT], { cwd });
  log(`committed "${FIRST_COMMIT}"`);
  return true;
}

/** The package manager named first in `npm_config_user_agent` (`pnpm/11.1.0 npm/? node/v24…`), else pnpm. */
export function packageManagerOf(userAgent: string | undefined): string {
  const name = userAgent?.split("/")[0];
  return name === "npm" || name === "yarn" || name === "bun" ? name : "pnpm";
}

/** A directory's name as a package's: lower case, runs of anything else made one `-`; `company` when nothing is left. */
export const packageName = (dir: string) =>
  dir
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|-+$/g, "") || "company";

/** Adds each variable the file does not set yet, keeping the file's own. */
function writeEnv(file: string, values: Record<string, string>): void {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const set = parseEnv(text);
  const added = Object.entries(values).filter(([name]) => !(name in set));
  const lines = added.map(([name, value]) => `${name}=${value}\n`).join("");
  writeFileSync(file, text && !text.endsWith("\n") ? `${text}\n${lines}` : text + lines);
}

const installWith = (cwd: string, packageManager: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(packageManager, ["install"], { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${packageManager} install failed; run it in ${cwd}, then sanoma`)),
    );
  });
