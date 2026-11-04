// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { errorMessage, memorySecrets, type Principal } from "@sanoma-ai/workflows";
import { type DataValue, formatOptions, renderDataFile } from "@sanoma-ai/workflows/describe";
import { secret as secretOf } from "@sanoma-ai/workflows/resources";
import {
  ApiError,
  type ConnectExistingRequest,
  type ConnectExistingResponse,
  INFRA,
  PASSWORD_NOTE,
} from "../../api.ts";
import type { AppContext } from "../../context.ts";

// Connecting an existing repository or database: each is imported by its name or ref, declared
// in `resources/sanoma/infra.ts` from what was read, and bound to that file's declaration by an
// apply run that only binds. In a repository with a remote, the file goes on a branch of its own
// for a person to merge; without one (local), it is committed where the checkout is.

/** The branch the change waits on, in a repository with a remote. */
export const CONNECT_BRANCH = "setup/connect-existing";

/**
 * What each existing object is declared as: its export, its type, the constructors' import, the
 * fields copied from what the vendor holds (none vendor-owned or write-only), and those set here.
 */
const EXISTING = {
  repository: {
    name: "repo",
    vendor: "github",
    type: "repository",
    source: "@sanoma-ai/connector-github/resources",
    fields: ["owner", "name", "description", "visibility"],
    set: {},
  },
  // Supabase never reads the password back: declared generated, it is set by the next apply that
  // changes the project, not by this one, which only binds.
  project: {
    name: "store",
    vendor: "supabase",
    type: "project",
    source: "@sanoma-ai/connector-supabase/resources",
    fields: ["name", "organization_id", "region"],
    set: { database_password: secretOf("SUPABASE_DB_PASSWORD", { generate: true }) },
  },
} as const;

/**
 * Connects an existing GitHub repository and/or Supabase project: imports each through its
 * type's import, renders `INFRA` from what was read, commits it through the app's source
 * (on `CONNECT_BRANCH`, checked out, when the repository has a remote), then starts apply with
 * `bind` and `only` for those declarations, so the lockfile gets their bindings and nothing is
 * created. A 409 when the file is there already or the branch is; a 400 when a type has no
 * connector here, or the vendor has no such object.
 *
 * The imports run here, before the file they declare exists, so outside any run: the policy and
 * the ledger see apply's own import of each, by its binding, when it binds them.
 */
export function connectExisting(
  app: AppContext,
  actor: Principal,
  request: ConnectExistingRequest,
): Promise<ConnectExistingResponse> {
  const done = connecting.then(() => connectNow(app, actor, request));
  connecting = done.catch(() => undefined);
  return done;
}

/** The connect under way, if any: one at a time, so two never both find no file and write it. */
let connecting: Promise<unknown> = Promise.resolve();

async function connectNow(
  { client, resolved, local }: AppContext,
  actor: Principal,
  request: ConnectExistingRequest,
): Promise<ConnectExistingResponse> {
  const { root } = resolved;
  if (root === undefined) throw new Error("The config has no root, so its data files cannot be written");
  const path = join(root, INFRA);
  if (existsSync(path)) {
    throw new ApiError(409, { error: `${INFRA} is there already: declare what to connect in it instead` });
  }
  const wanted = (["repository", "project"] as const).flatMap((what) => {
    const given = request[what];
    return given ? [{ ...EXISTING[what], given }] : [];
  });
  // A repository is imported by `<owner>/<name>`, a project by its ref: each by what was given.
  const states = await Promise.all(
    wanted.map(({ vendor, type, given }) => imported(resolved, `${vendor}.${type}`, given)),
  );
  const exports = [];
  const bind: Record<string, string> = {};
  for (const [i, at] of wanted.entries()) {
    const state = states[i]!;
    const read = at.fields.flatMap((f) => (state[f] == null || state[f] === "" ? [] : [[f, state[f] as DataValue]]));
    exports.push({ ...at, desired: { ...Object.fromEntries(read), ...at.set } });
    bind[`${INFRA}#${at.name}`] = resolved.types.get(`${at.vendor}.${at.type}`)!.bindingId(state);
  }
  const imports = wanted.map(({ vendor, source: from }) => ({ source: from, imported: vendor, local: vendor }));
  const rendered = await renderDataFile({ imports, exports }, formatOptions(root));
  const text = request.project ? `${PASSWORD_NOTE.map((line) => `// ${line}\n`).join("")}${rendered}` : rendered;

  const source = local?.source;
  const git = source && (await gitAt(source.root));
  const branch = git && (await git("remote")) ? CONNECT_BRANCH : undefined;
  if (branch) {
    try {
      await git!("switch", "--quiet", "-c", branch);
    } catch (err) {
      throw new ApiError(409, { error: `Could not start the branch ${branch}: ${errorMessage(err)}` });
    }
  }
  const names = wanted.map((w) => `${w.vendor} ${w.given}`).join(" and ");
  let commit: { revision: string } | undefined;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    commit = await source?.commit({
      paths: [relative(source.root, path)],
      message: `Connect ${names}`,
      author: actor.id,
    });
  } catch (err) {
    // Left as it was: no file, and back on the branch it started from, so connecting again works.
    await rm(path, { force: true });
    if (branch) await git!("switch", "--quiet", "-").then(() => git!("branch", "-D", branch));
    throw new ApiError(500, { error: `Could not commit ${INFRA}: ${errorMessage(err)}` });
  }
  const diff = branch && commit ? await git!("show", "--format=", commit.revision) : undefined;
  const runId = await client.apply({ only: Object.keys(bind), bind }, { startedBy: actor }).catch((err: unknown) => {
    throw new ApiError(500, {
      error: `Committed ${INFRA}, but could not start the apply that binds it: ${errorMessage(err)}. Apply it from Hosting.`,
    });
  });
  return { file: INFRA, text, runId, ...commit, ...(branch && { branch }), ...(diff && { diff }) };
}

/**
 * The state of the object `id` names, read through its type's import; a 400 when the config has
 * no driver for it, or the vendor has no such object, or the read fails.
 */
async function imported(resolved: AppContext["resolved"], type: string, id: string) {
  const opId = `${type}.import`;
  const driver = resolved.drivers.get(opId);
  if (!driver) {
    const vendor = type.slice(0, type.indexOf("."));
    throw new ApiError(400, {
      error: `Connecting a ${type} needs @sanoma-ai/connector-${vendor} among the config's connectors`,
    });
  }
  // A read: it needs no secret, and nothing it is given names one.
  const call = { idempotencyKey: randomUUID(), runId: "setup", opId, attempt: 1, secrets: memorySecrets() };
  let found: { gone: boolean; state?: Record<string, unknown> };
  try {
    found = (await driver({ id }, call)) as typeof found;
  } catch (err) {
    throw new ApiError(400, { error: `Could not read the ${type} ${id}: ${errorMessage(err)}` });
  }
  if (found.gone || !found.state) throw new ApiError(400, { error: `There is no ${type} ${id} to connect` });
  return found.state;
}

const execGit = promisify(execFile);

/** Git in `root`, when it is a git checkout: each call's output, trimmed. */
async function gitAt(root: string) {
  const run = async (...args: string[]) =>
    (await execGit("git", args, { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();
  return (await run("rev-parse", "--is-inside-work-tree").catch(() => "")) === "true" ? run : undefined;
}
