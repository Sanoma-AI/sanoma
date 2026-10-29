import { execFile, spawn } from "node:child_process";
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
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RUNTIME_AGENTS } from "@sanoma-ai/workflows";
import { readPeople } from "@sanoma-ai/workflows/describe";
import { groupNamesOf, isVisitor, principalIdsOf } from "@sanoma-ai/workflows/shared";
import { writeDeploymentKeys } from "./key.ts";

const run = promisify(execFile);

/** The company template this package ships (`files`): `template/` beside `src/` and `dist/`. */
export const TEMPLATE = new URL("../template/", import.meta.url);

export const FIRST_COMMIT = "Start a Sanoma company";

/** What each package manager writes beside `package.json`. */
const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock"];

/** Who starts the company: the first person `resources/people.ts` declares. */
export interface Creator {
  id: string;
  name?: string;
  github?: string;
}

export interface StartOptions {
  /** Runs `<packageManager> install` in the directory; the default inherits this process's stdio. */
  install?: (cwd: string, packageManager: string) => Promise<void>;
  /** Who is starting it; the default asks `gh` and git (`whoIsStarting`). */
  creator?: () => Promise<Creator>;
  log?: (line: string) => void;
}

/**
 * `sanoma` where there is no `sanoma.config.ts`: in an empty directory (dotfiles aside) it starts
 * a company there and says so; anywhere else it does nothing and says it did not. Starting copies
 * the template, names the package after the directory, declares whoever starts it as the first
 * person in `resources/people.ts` (so the app admits them), writes `.env` (a new
 * signing and encryption key, keeping what it already holds; no database URL, so `sanoma` runs the
 * company's own Postgres), commits what it wrote as the first
 * commit of a git repository, as the machine's git user, then installs with the package manager
 * that ran this (`npm_config_user_agent`, else pnpm) and adds the lockfile to that commit. Throws
 * before writing anything when git is missing or has no user to commit as.
 */
export async function startCompany(
  cwd: string,
  { install = installWith, creator = whoIsStarting, log = () => {} }: StartOptions = {},
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
  // The template is this launcher's, so `sanoma` at its version; the rest (each versioned on its own) at `latest`.
  pkg.dependencies.sanoma = `^${own.version}`;
  writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);

  const people = join(cwd, "resources", "people.ts");
  writeFileSync(people, declareFounder(readFileSync(people, "utf8"), await creator()));

  writeDeploymentKeys(join(cwd, ".env"));

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

/** The template's founder, `export const founder = sanoma.person(…)`, which `sanoma init` declares as the creator. */
const FOUNDER = /^export const founder = sanoma\.person\(.*\);$/m;

/** The people file with its founder declared as `creator`. */
export function declareFounder(text: string, creator: Creator): string {
  const fields = Object.entries(creator)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  if (!FOUNDER.test(text)) throw new Error("the template's resources/people.ts declares no `founder`");
  // A replacer, so a `$` in a name is kept as written.
  return text.replace(FOUNDER, () => `export const founder = sanoma.person({ ${fields.join(", ")} });`);
}

/** What a command prints, trimmed; empty when it fails or is missing. */
const output = (cmd: string, args: string[]) =>
  run(cmd, args, { timeout: 10_000 }).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  );

/**
 * `id`, unless it is empty or taken, by a person, agent or group the template declares, by one
 * of the runtime's own agents or by the visitors (`isVisitor`): then "founder".
 */
function free(id: string): string {
  const { people } = readPeople(fileURLToPath(TEMPLATE));
  const taken = [...principalIdsOf(people), ...groupNamesOf(people), ...RUNTIME_AGENTS];
  return id && !taken.includes(id) && !isVisitor({ id }) ? id : "founder";
}

/** This machine's user name as one word; empty when the OS names none. */
function machineUser(): string {
  try {
    return userInfo().username.replace(/\s+/g, "-");
  } catch {
    return "";
  }
}

/**
 * Who is starting the company: their GitHub login, as `gh` is signed in, which the GitHub sign-in
 * matches and the loopback sign-in takes as the id; else this machine's user name. Named as git's
 * `user.name`, which `startCompany` requires.
 */
export async function whoIsStarting(): Promise<Creator> {
  const [login, name] = await Promise.all([
    output("gh", ["api", "user", "--jq", ".login"]),
    output("git", ["config", "user.name"]),
  ]);
  const named = name ? { name } : {};
  if (/^[A-Za-z0-9-]+$/.test(login)) return { id: free(login), github: login, ...named };
  return { id: free(machineUser()), ...named };
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

const installWith = (cwd: string, packageManager: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(packageManager, ["install"], { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${packageManager} install failed; run it in ${cwd}, then sanoma`)),
    );
  });
