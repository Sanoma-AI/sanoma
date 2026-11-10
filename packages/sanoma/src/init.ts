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
import { basename, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AGENTS, RUNTIME_AGENTS, VISITORS } from "sanoma/workflows";
import { isVisitor, slugged } from "sanoma/workflows/shared";
import { z } from "zod";
import { stage } from "./events.ts";
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
  /** Their email: what the staff login sends a sign-in code to, and an invite is for, on a host. */
  email?: string;
}

export interface StartOptions {
  /** The company's name, as the app shows it (`name` in `sanoma.config.ts`); without one, the directory's name stands. */
  name?: string;
  /** Runs `<packageManager> install` in the directory; the default inherits this process's stdio. */
  install?: (cwd: string, packageManager: string) => Promise<void>;
  /** Who is starting it; the default asks `gh` and git (`whoIsStarting`). */
  creator?: () => Promise<Creator>;
  log?: (line: string) => void;
}

/**
 * `sanoma init`, and `sanoma` where there is no `sanoma.config.ts`: starts a company in `cwd` when
 * it is empty (dotfiles aside), from the template, as the first commit of a git repository, its
 * dependencies installed, each stage a `stage` event; whether it did. Throws before writing
 * anything when git is missing or has no user to commit as.
 */
export async function startCompany(
  cwd: string,
  { name, install = installWith, creator = whoIsStarting, log = () => {} }: StartOptions = {},
): Promise<boolean> {
  if (readdirSync(cwd).some((file) => !file.startsWith("."))) return false;
  await run("git", ["var", "GIT_AUTHOR_IDENT"]).catch((err: unknown) => {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    throw new Error(
      missing ? "git is not installed" : "git needs a user to commit as: set git config user.name and user.email",
      { cause: err },
    );
  });
  log(`starting a Sanoma company in ${cwd}`);
  // Asked now, while the template is copied: `gh` may take its time.
  const who = creator();
  who.catch(() => {});
  const packageManager = packageManagerOf(process.env.npm_config_user_agent);
  await stage("template", () => copyTemplate(cwd, name, packageManager));
  await stage("people", async () => {
    const founder = await who;
    editIn(cwd, "resources/people.ts", (text) => declareFounder(text, founder));
  });

  // Committed before the install, so a failed install leaves a repository to rerun it in; the
  // lockfile joins the same commit after. Only what this wrote: a dotfile already here may be a secret.
  const commit = async (...args: string[]) => {
    const wrote = [...readdirSync(TEMPLATE), ...LOCKFILES]
      .map((file) => (file === "gitignore" ? ".gitignore" : file))
      .filter((file) => existsSync(join(cwd, file)));
    await run("git", ["add", "--", ...wrote], { cwd });
    await run("git", ["commit", "--quiet", "-m", FIRST_COMMIT, ...args], { cwd });
  };
  await stage("git", async () => {
    await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd });
    await commit();
  });
  log(`committed "${FIRST_COMMIT}"; installing with ${packageManager}`);
  await stage("install", async () => {
    await install(cwd, packageManager);
    await commit("--amend");
  });
  return true;
}

/**
 * The template copied into `cwd`: its `.gitignore`, the package named after the directory, the
 * company's `name` and slug, `.env`, and pnpm's workspace file for pnpm alone.
 */
function copyTemplate(cwd: string, name: string | undefined, packageManager: string): void {
  cpSync(TEMPLATE, cwd, { recursive: true, force: false });
  // npm drops a package's .gitignore, so the template carries it as gitignore.
  const [carried, ignore] = [join(cwd, "gitignore"), join(cwd, ".gitignore")];
  if (!existsSync(ignore)) renameSync(carried, ignore);
  else {
    appendFileSync(ignore, `\n${readFileSync(carried, "utf8")}`);
    rmSync(carried);
  }

  const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Manifest;
  const manifest = join(cwd, "package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name: string; dependencies: Record<string, string> };
  const packaged = packageName(basename(cwd));
  // npm refuses to install a package into one of the same name (`sanoma` in `sanoma/`).
  pkg.name = packaged in pkg.dependencies ? `${packaged}-company` : packaged;
  if (INSTALLED) pkg.dependencies = pinDependencies(pkg.dependencies, own);
  writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);

  if (name) editIn(cwd, "sanoma.config.ts", (text) => declareName(text, name));
  editIn(cwd, INFRA, (text) => declareSlug(text, slugOf(name, basename(cwd))));

  writeDeploymentKeys(join(cwd, ".env"));
  if (packageManager !== "pnpm") rmSync(join(cwd, "pnpm-workspace.yaml"));
}

/** Writes `file` in `cwd` again as `change` makes its text. */
const editIn = (cwd: string, file: string, change: (text: string) => string) =>
  writeFileSync(join(cwd, file), change(readFileSync(join(cwd, file), "utf8")));

/**
 * Whether this launcher is an installed release (its real path under `node_modules`), not a checkout's,
 * whose version npm may not have yet: from a checkout, the template's ranges stand.
 */
const INSTALLED = fileURLToPath(import.meta.url)
  .split(sep)
  .includes("node_modules");

/** What `pinDependencies` reads of this package's own manifest. */
export interface Manifest {
  version: string;
}

/**
 * The template's dependencies at the versions released with it, as a company starts from them:
 * `sanoma` and each `@sanoma-ai/connector-*` at this launcher's own version, as every published
 * package carries sanoma's version (`scripts/release-check.ts`). The template's
 * `pnpm-workspace.yaml` lets its install past pnpm's minimum release age, so a range or `latest`
 * here would meet a release newer than this template and what it allows. Any other dependency
 * stays as the template names it. Applied only by an installed launcher (`INSTALLED`).
 */
export function pinDependencies(dependencies: Record<string, string>, own: Manifest): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, range]) => [
      name,
      name === "sanoma" || name.startsWith("@sanoma-ai/connector-") ? own.version : range,
    ]),
  );
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

/** Where the template declares the company's database and host on Sanoma Cloud. */
const INFRA = "resources/sanoma/infra.ts";

/** The template config's opening, after which `declareName` writes the company's name. */
const CONFIG_OPENING = /^export default defineConfig\(\{\n/m;

/** The config file with the company's `name` declared first. */
export function declareName(text: string, name: string): string {
  if (!CONFIG_OPENING.test(text))
    throw new Error("the template's sanoma.config.ts has no `export default defineConfig({`");
  return text.replace(CONFIG_OPENING, (opening) => `${opening}  name: ${JSON.stringify(name)},\n`);
}

/** The template's slug in `resources/sanoma/infra.ts`, which its Cloud names and address are made of. */
const TEMPLATE_SLUG = /^const slug = "company";$/m;

/** The infra file with the company's slug for the template's. */
export function declareSlug(text: string, slug: string): string {
  if (!TEMPLATE_SLUG.test(text)) throw new Error(`the template's ${INFRA} has no \`const slug = "company";\``);
  return text.replace(TEMPLATE_SLUG, () => `const slug = ${JSON.stringify(slug)};`);
}

/**
 * A company's Sanoma Cloud slug, its address `<slug>.sanoma.work`: its name's (`slugged`), else its
 * directory's when the name gives none; lower case letters, digits and single dashes, a dash at
 * neither end, 3 to 40 of them, as the Cloud takes it; a shorter one gains `-company`, and none at
 * all is `company`.
 */
export function slugOf(name: string | undefined, dir: string): string {
  const [slug = ""] = [name ?? "", dir].map((text) => slugged(text).slice(0, 40).replace(/-+$/, "")).filter(Boolean);
  return slug.length >= 3 ? slug : [slug, "company"].filter(Boolean).join("-");
}

/** What a command prints, trimmed; empty when it fails or is missing. */
const output = (cmd: string, args: string[]) =>
  run(cmd, args, { timeout: 10_000 }).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  );

/**
 * The ids and group names the template's `resources/people.ts` declares, read from its text: the
 * template is inside the installed package, under `node_modules`, where Node strips no types, so
 * it cannot be loaded there.
 */
export function templatePeopleIds(): string[] {
  const text = readFileSync(new URL("resources/people.ts", TEMPLATE), "utf8");
  return [...text.matchAll(/\.(?:person|agent)\(\{[^}]*?\bid:\s*"([^"]+)"|\.group\(\{[^}]*?\bname:\s*"([^"]+)"/g)].map(
    (m) => m[1] ?? m[2]!,
  );
}

/**
 * `id`, unless it is empty or taken, by a person, agent or group the template declares, by one
 * of the runtime's own agents or by the visitors (`isVisitor`): then "founder".
 */
function free(id: string): string {
  const taken = [...templatePeopleIds(), AGENTS, VISITORS, ...RUNTIME_AGENTS];
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

/** Whether `text` is an email address as the people file takes one: what a host's staff login can send a code to. */
export const isEmail = (text: string) => z.email().safeParse(text).success;

/**
 * Who is starting the company: their GitHub login, as `gh` is signed in, which the GitHub sign-in
 * matches and the loopback sign-in takes as the id; else this machine's user name. Named as `given`
 * says (`sanoma init --you --email`), else as git's `user.name`, which `startCompany` requires, with
 * git's `user.email`, which a host's staff login sends sign-in codes to.
 */
export async function whoIsStarting(given: { name?: string; email?: string } = {}): Promise<Creator> {
  const [login, name, email] = await Promise.all([
    output("gh", ["api", "user", "--jq", ".login"]),
    given.name || output("git", ["config", "user.name"]),
    given.email || output("git", ["config", "user.email"]),
  ]);
  const named = { ...(name && { name }), ...(isEmail(email) && { email }) };
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

/**
 * `<packageManager> install`, through a shell: on Windows pnpm, npm and yarn are `.cmd` shims, which
 * Node starts only through one. As one string, as Node deprecates arguments beside `shell`; nothing
 * in it needs quoting, the package manager being one of `packageManagerOf`'s names.
 */
const installWith = (cwd: string, packageManager: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(`${packageManager} install`, { cwd, stdio: "inherit", shell: true, windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${packageManager} install failed; run it in ${cwd}, then sanoma`)),
    );
  });
