import { execFileSync } from "node:child_process";
import {
  apiNameOf,
  BUILT_IN_WORKFLOWS,
  DESCRIBE_CALL,
  errorMessage,
  isLoopback,
  personOf,
  personsOf,
  UsageError,
} from "sanoma/workflows/shared";
import { runningApp } from "./app-file.ts";
import { loadDotEnv } from "./config.ts";

// `sanoma describe` and `sanoma call`: thin clients of a running app's `POST /api/call`, which does
// the dispatch (`callApi`). Only Node's modules, sanoma/workflows/shared, `./app-file.ts` and
// `./config.ts` for its `.env`, so neither command loads the worker or the app; the declared people
// are read through sanoma/workflows/describe, imported only when they are (`readPeople`).

/** What the two commands take from the command line. */
export interface CallOptions {
  /** `--input`: the call's input, as JSON text. */
  input?: string;
  /** `--as`: who is asking, a declared person's id, email or GitHub login. */
  as?: string;
  /** `--url`: where the app listens. */
  url?: string;
  /** `--agent`: the declared agent the call is made by, for the person. */
  agent?: string;
}

/** How long one request may take: a `.result` waits up to 20 s on the server before it answers `run_running`. */
const REQUEST_TIMEOUT_MS = 60_000;

/** How long `<workflow>.result` keeps asking while the run is running: 10 minutes. */
export const RESULT_DEADLINE_MS = 10 * 60_000;

/** The reads of a workflow's runs `callApi` answers (`<api>.<read>`), which start nothing and take no id. */
const READS = new Set(["result", "latest", "runs", "approvals", "ledger"]);

/** The headers the loopback login reads (`ACTOR_HEADER` and `AGENT_HEADER` in the app's `api.ts`, not imported: it is the app's). */
const ACTOR_HEADER = "x-sanoma-actor";
const AGENT_HEADER = "x-sanoma-agent";

/** `sanoma describe`: the app's description for an agent (`sanoma.describe`), as JSON on stdout. */
export async function describeCommand(options: CallOptions): Promise<number> {
  if (options.input !== undefined) throw new UsageError("sanoma describe takes no --input");
  return request(DESCRIBE_CALL, undefined, options);
}

/**
 * `sanoma call <name>`: a workflow started (by its api name, or `<api>.start`), a run read
 * (`<api>.result`, asked again while the run is running, up to `RESULT_DEADLINE_MS`), or an
 * operation called by its id, as `POST /api/call` takes them; the answer as JSON on stdout. The
 * runtime's own workflows are refused, as `/mcp`'s `start_run` refuses them; their runs' reads are not.
 */
export async function callCommand(name: string, options: CallOptions): Promise<number> {
  let input: unknown;
  if (options.input !== undefined) {
    try {
      input = JSON.parse(options.input);
    } catch (err) {
      throw new UsageError(`--input is not JSON: ${errorMessage(err)}`);
    }
  }
  const builtIn = builtInStarted(name);
  if (builtIn) {
    throw new UsageError(`${builtIn} is the runtime's own workflow: the runtime's own workflows are not started here`);
  }
  return request(name, input, options);
}

/** The built-in workflow `name` starts (by its name or api name, with or without `.start`), if it is one. */
function builtInStarted(name: string): string | undefined {
  const started = name.endsWith(".start") ? name.slice(0, -".start".length) : name;
  return [...BUILT_IN_WORKFLOWS].find((workflow) => workflow === started || apiNameOf(workflow) === started);
}

/** Sends the call, asking a `.result` again while its run is running, and prints the answer. */
async function request(name: string, input: unknown, options: CallOptions): Promise<number> {
  const cwd = process.cwd();
  const app = appUrl(options.url, cwd);
  const person = await personAsking(options.as, cwd);
  const [, method, ...rest] = name.split(".");
  const read = name === DESCRIBE_CALL || (method !== undefined && !rest.length && READS.has(method));
  const result = method === "result" && !rest.length;
  // A start or an operation's call carries an id of its own, so the app makes it once.
  const body = { name, ...(input !== undefined && { input }), ...(!read && { id: crypto.randomUUID() }) };
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    // `/api/call` refuses a request that says nothing of where it comes from (its CSRF check):
    // this one comes from no other site's page, so it names the app's own origin.
    origin: app.origin,
    [ACTOR_HEADER]: encodeURIComponent(person),
    ...(options.agent !== undefined && { [AGENT_HEADER]: encodeURIComponent(options.agent) }),
  };
  const until = Date.now() + RESULT_DEADLINE_MS;
  for (;;) {
    const answer = await send(app, headers, body);
    if (answer.ok) {
      process.stdout.write(`${JSON.stringify(answer.body, null, process.stdout.isTTY ? 2 : undefined)}\n`);
      return 0;
    }
    if (result && answer.problem?.code === "run_running" && Date.now() < until) continue;
    throw new Error(failure(app, answer.status, answer.problem, answer.text, result));
  }
}

/** An error body as `/api/call` answers it (`ErrorResponse`). */
interface Problem {
  error?: string;
  code?: string;
  runId?: string;
  issues?: { path?: (string | number)[]; message?: string }[];
}

type Answer = { ok: true; body: unknown } | { ok: false; status: number; problem?: Problem; text: string };

/** One `POST /api/call`: the answer, or an error naming the address when nothing answers. */
async function send(app: URL, headers: Record<string, string>, body: object): Promise<Answer> {
  let res: Response;
  try {
    res = await fetch(new URL("/api/call", app), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // A redirect is no answer of the api's (a host's sign-in page, say), and would carry the headers elsewhere.
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = (err as { name?: string } | null)?.name === "TimeoutError";
    if (timedOut) {
      throw new Error(`The app at ${app.origin} did not answer in ${REQUEST_TIMEOUT_MS / 1000} s`, { cause: err });
    }
    const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
    throw new Error(
      `Nothing answers at ${app.origin} (${cause?.code ?? cause?.message ?? errorMessage(err)}): start the app with sanoma, or name where it runs with --url`,
      { cause: err },
    );
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = undefined;
  }
  if (res.ok && parsed !== undefined) return { ok: true, body: parsed };
  const problem = typeof parsed === "object" && parsed !== null ? (parsed as Problem) : undefined;
  return { ok: false, status: res.status, ...(problem && { problem }), text };
}

/** The message a refused or failed call exits 1 with: the app's error, its code, the run, the input's issues. */
function failure(app: URL, status: number, problem: Problem | undefined, text: string, result: boolean): string {
  const lines: string[] = [];
  if (problem?.error) {
    lines.push(`${problem.error}${problem.code ? ` (${problem.code})` : ""}`);
  } else if (status >= 300 && status < 400) {
    lines.push(`The app at ${app.origin} answered with a redirect (HTTP ${status}), not an answer of its api`);
  } else {
    const said = text.trim().slice(0, 200);
    lines.push(`The app at ${app.origin} answered HTTP ${status}${said ? `: ${said}` : ""}`);
  }
  if (problem?.runId) {
    lines.push(
      problem.code === "run_running" && result
        ? `run ${problem.runId} has not ended in ${RESULT_DEADLINE_MS / 60_000} minutes: ask again for its result`
        : `run ${problem.runId}`,
    );
  }
  for (const issue of problem?.issues ?? []) {
    lines.push(`  ${issue.path?.length ? issue.path.join(".") : "(the input)"}: ${issue.message ?? "invalid"}`);
  }
  // A host's app says who is asking from its sign-in, which these commands do not give.
  if ([301, 302, 303, 307, 308, 400, 401, 403].includes(status) && !isLoopback(app.hostname)) {
    lines.push(
      `${app.host} is not this machine: sanoma call and sanoma describe sign in only to an app on this machine, and a hosted app's sign-in refuses them`,
    );
  }
  return lines.join("\n");
}

/**
 * Where the app listens: `--url`; else the app `.sanoma/app.json` names in the working directory
 * while its process runs (`runningApp`, written by `sanoma`, `sanoma serve` and `sanoma app` when
 * they listen); else `SANOMA_APP_HOST` (default 127.0.0.1; any address, 0.0.0.0 or ::, as this
 * machine's) and `SANOMA_APP_PORT` (default 3000), after the `.env` there. A port of 0, any free
 * one, says nothing of where: a `UsageError` asking for `--url`.
 */
export function appUrl(url: string | undefined, cwd: string): URL {
  if (url !== undefined) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      parsed = undefined;
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      throw new UsageError(`--url: "${url}" is not an http(s) URL, such as http://127.0.0.1:3000`);
    }
    return parsed;
  }
  const running = runningApp(cwd);
  if (running) return new URL(running.url);
  loadDotEnv(cwd);
  const port = process.env.SANOMA_APP_PORT || "3000";
  if (Number(port) === 0) {
    throw new UsageError(
      "SANOMA_APP_PORT is 0, any free port, and no running app here says which: name the app's address with --url (sanoma prints it)",
    );
  }
  const named = process.env.SANOMA_APP_HOST || "127.0.0.1";
  const host = named === "0.0.0.0" ? "127.0.0.1" : named === "::" ? "::1" : named;
  return new URL(`http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`);
}

/**
 * Who is asking, by a declared person's id: `--as` (an id, an email or a GitHub login, matched with
 * `personOf` when people are declared; with none, taken as it is); else the one person declared, as
 * the app's picker takes them; else the one git's `user.email` names. Otherwise a `UsageError`
 * listing the declared ids. The people are read from `resources/` in the working directory
 * (`readPeople`, imported only here).
 */
export async function personAsking(as: string | undefined, cwd: string): Promise<string> {
  const named = as?.trim();
  if (as !== undefined && !named) throw new UsageError("--as names nobody");
  const { readPeople } = await import("sanoma/workflows/describe");
  let declared: ReturnType<typeof readPeople>["people"];
  try {
    declared = readPeople(cwd).people;
  } catch (err) {
    // The app reads them too, and refuses whom they do not admit.
    if (named) return named;
    throw new Error(`Could not read the people in ${cwd}/resources: ${errorMessage(err)}`, { cause: err });
  }
  const people = personsOf(declared);
  const ids = people.map((p) => p.id).join(", ");
  if (named) {
    if (!people.length) return named;
    const id = personOf({ email: named, github: named, id: named }, declared);
    if (id) return id;
    throw new UsageError(`--as: ${named} is no declared person; the people are ${ids}`);
  }
  if (!people.length) throw new UsageError("No person is declared in resources/: say who is asking with --as <id>");
  if (people.length === 1) return people[0]!.id;
  const email = gitEmail(cwd);
  const id = email && personOf({ email }, declared);
  if (id) return id;
  throw new UsageError(
    `Say who is asking with --as <id or email>: the people are ${ids}` +
      (email ? `, and git's user.email ${email} is none of theirs` : ""),
  );
}

/** Git's `user.email` in `cwd`, or undefined when git has none (or there is no git). */
function gitEmail(cwd: string): string | undefined {
  try {
    return (
      execFileSync("git", ["config", "user.email"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}
