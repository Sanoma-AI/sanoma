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

/** What each package manager writes beside `package.json`. */
const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock"];

export interface StartOptions {
  /** Runs `<packageManager> install` in the directory; the default inherits this process's stdio. */
  install?: (cwd: string, packageManager: string) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * `sanoma` where there is no `sanoma.config.ts`: in an empty directory (dotfiles aside) it starts
 * a company there and says so; anywhere else it does nothing and says it did not. Starting copies
 * the template, names the package after the directory, writes `.env` (the default database and a
 * new `SANOMA_SECRETS_KEY`, keeping what it already holds), commits what it wrote as the first
 * commit of a git repository, as the machine's git user, then installs with the package manager
 * that ran this (`npm_config_user_agent`, else pnpm) and adds the lockfile to that commit. Throws
 * before writing anything when git is missing or has no user to commit as.
 */
export async function startCompany(
  cwd: string,
  { install = installWith, log = () => {} }: StartOptions = {},
): Promise<boolean> {
  if (readdirSync(cwd).some((name) => !name.startsWith("."))) return false;
  await run("git", ["var", "GIT_AUTHOR_IDENT"]).catch((err: unknown) => {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    throw new Error(
      missing ? "git is not installed" : "git needs a user to commit as: set git config user.name and user.email",
      { cause: err },
    );
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
  const name = packageName(basename(cwd));
  // npm refuses to install a package into one of the same name (`sanoma` in `sanoma/`).
  pkg.name = name in pkg.dependencies ? `${name}-company` : name;
  // The template's packages at this launcher's version: Sanoma releases them together.
  for (const dep of Object.keys(pkg.dependencies)) pkg.dependencies[dep] = `^${own.version}`;
  writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);

  writeEnv(join(cwd, ".env"), {
    SANOMA_DATABASE_URL: DATABASE_URL,
    SANOMA_SECRETS_KEY: randomBytes(32).toString("base64"),
  });

  const packageManager = packageManagerOf(process.env.npm_config_user_agent);
  if (packageManager !== "pnpm") rmSync(join(cwd, "pnpm-workspace.yaml"));

  // Committed before the install, so a failed install leaves a repository to rerun it in; the
  // lockfile joins the same commit after. Only what this wrote: a dotfile already here may be a secret.
  const commit = async (...args: string[]) => {
    const wrote = [...readdirSync(TEMPLATE), ...LOCKFILES]
      .map((file) => (file === "gitignore" ? ".gitignore" : file))
      .filter((file) => existsSync(join(cwd, file)));
    await run("git", ["add", "--", ...wrote], { cwd });
    await run("git", ["commit", "--quiet", "-m", FIRST_COMMIT, ...args], { cwd });
  };
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd });
  await commit();
  log(`committed "${FIRST_COMMIT}"; installing with ${packageManager}`);
  await install(cwd, packageManager);
  await commit("--amend");
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
