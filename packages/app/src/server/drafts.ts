import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type CheckResult, errorMessage } from "@sanoma-ai/workflows";

/** How long a check may take before it is stopped and its result is that. */
const CHECK_TIMEOUT_MS = 15 * 60_000;

/**
 * `sanoma check` on the draft at `root` (a `Source.draft`'s), as a child in it: the `sanoma` its
 * `node_modules` holds, with this Node, an environment of `PATH`, `HOME` and `databaseUrl` alone
 * (no credential of this process, no `.env`: a draft has none), and `SANOMA_EVENTS=1` for its
 * result. One at a time, whichever the draft: every check runs its scenarios on the one
 * `<database>_check`. A check that gives no result (a config that does not load, no install, the
 * timeout) is a result of one problem, saying why.
 */
export function checks(root: string, databaseUrl: string): Promise<CheckResult> {
  const done = checking.then(() => checkNow(root, databaseUrl).catch((err: unknown) => failed(errorMessage(err))));
  checking = done;
  return done;
}

/** The check under way, if any. */
let checking: Promise<unknown> = Promise.resolve();

const failed = (why: string): CheckResult => ({ ok: false, problems: [`sanoma check: ${why}`], warnings: [] });

interface Ran {
  stdout: string;
  stderr: string;
  killed?: boolean;
  code?: unknown;
}

async function checkNow(root: string, databaseUrl: string): Promise<CheckResult> {
  // The company's own install (linked into the draft).
  const sanoma = join(root, "node_modules", "sanoma");
  const { bin } = JSON.parse(await readFile(join(sanoma, "package.json"), "utf8")) as {
    bin: string | { sanoma: string };
  };
  const env: NodeJS.ProcessEnv = { SANOMA_DATABASE_URL: databaseUrl, SANOMA_EVENTS: "1" };
  for (const name of ["PATH", "HOME"] as const) if (process.env[name]) env[name] = process.env[name];
  const ran: Ran = await promisify(execFile)(
    process.execPath,
    [join(sanoma, typeof bin === "string" ? bin : bin.sanoma), "check"],
    {
      cwd: root,
      env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: CHECK_TIMEOUT_MS,
    },
  ).catch((err: Ran & { message: string }) => ({ ...err, stderr: err.stderr || err.message }));
  if (ran.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return failed("it printed more than its 64 MiB");
  if (ran.killed) return failed(`stopped after ${CHECK_TIMEOUT_MS / 60_000} minutes`);
  // Beside the lines a person reads (and DBOS's), each event is a line of its own. The last one
  // counts: the draft's own code, which the check imports, prints on the same stdout before it.
  let result: CheckResult | undefined;
  let error: string | undefined;
  for (const line of ran.stdout.split("\n")) {
    if (!line.startsWith('{"sanoma":1,')) continue;
    const event = JSON.parse(line) as { event: string; message?: string } & CheckResult;
    if (event.event === "checked") result = { ok: event.ok, problems: event.problems, warnings: event.warnings };
    if (event.event === "error") error = event.message;
  }
  return result ?? failed(error ?? (ran.stderr.trim().split("\n").at(-1) || "it gave no result"));
}
