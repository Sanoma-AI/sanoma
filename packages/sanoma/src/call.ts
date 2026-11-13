import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ACTOR_HEADER,
  AGENT_HEADER,
  builtInNamed,
  builtInRefusal,
  CALL_ID,
  DESCRIBE_CALL,
  errorMessage,
  isLoopback,
  personOf,
  personsOf,
  RUN_READS,
  UsageError,
} from "sanoma/workflows/shared";
import { APP_FILE, mainCheckout, runningApp } from "./app-file.ts";
import { appAddress, loadDotEnv } from "./config.ts";

// `sanoma describe` and `sanoma call`: thin clients of a running app's `POST /api/call`, which does
// the dispatch (`callApi`). Only Node's modules, sanoma/workflows/shared, `./app-file.ts` and
// `./config.ts` for its `.env`, so neither command loads the worker or the app; the company's root
// and its people are read through sanoma/workflows/describe (`configDirOf`, `companyRootOf`,
// `readPeople`), imported when the command runs.

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
  /** `--id`: the call's id, for a start or an operation's call: the same id twice is one call. */
  id?: string;
}

/** How long one request may take: a `.result` waits up to 20 s on the server before it answers `run_running`. */
const REQUEST_TIMEOUT_MS = 60_000;

/** How long `<workflow>.result` keeps asking while the run is running: 10 minutes. */
const RESULT_DEADLINE_MS = 10 * 60_000;

/** The least time between two requests of a `.result` asked again: one with `waitMs: 0` answers at once. */
const RETRY_MS = 1_000;

/** The reads of a workflow's runs (`RUN_READS`, as the app's `callApi` answers them), which start nothing and take no id. */
const READS: ReadonlySet<string> = new Set(RUN_READS);

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
  // A built-in, by its name or api name, with or without `.start`.
  const builtIn = builtInNamed(name.endsWith(".start") ? name.slice(0, -".start".length) : name);
  if (builtIn) throw new UsageError(builtInRefusal(builtIn));
  return request(name, input, options);
}

/** Where the call goes. */
interface Target {
  app: URL;
  /** Where the address came from, for a message that nothing answers there: empty for `--url`. */
  from: string;
  /** What says the app listens beyond this machine, and so signs people in (the staff login), when something does. */
  signIn?: string;
}

/** Sends the call, asking a `.result` again while its run is running, and prints the answer. */
async function request(name: string, input: unknown, options: CallOptions): Promise<number> {
  if (options.agent !== undefined && !options.agent.trim()) throw new UsageError("--agent names no agent");
  const [, method, ...rest] = name.split(".");
  const read = name === DESCRIBE_CALL || (method !== undefined && !rest.length && READS.has(method));
  const result = method === "result" && !rest.length;
  if (options.id !== undefined) {
    if (read) throw new UsageError(`--id is for a start or an operation's call: ${name} starts nothing`);
    if (!CALL_ID.test(options.id)) throw new UsageError(`--id: "${options.id}" is not an id: letters, digits, _ and -`);
  }
  const cwd = process.cwd();
  const { root, running } = await companyOf(cwd);
  if (root === undefined && options.url === undefined) {
    throw new UsageError(`No sanoma.config.ts in ${cwd}: run sanoma from the directory that holds it`);
  }
  // The company's `.env`, as the app it runs reads it.
  if (root !== undefined) loadDotEnv(root);
  const target = targetOf(options.url, running);
  const person = await personAsking(options.as, root);
  // A start or an operation's call carries an id, so the app makes it once: `--id`'s, else a new one.
  const id = read ? undefined : (options.id ?? crypto.randomUUID());
  const body = { name, ...(input !== undefined && { input }), ...(id !== undefined && { id }) };
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    // `/api/call` refuses a request that says nothing of where it comes from (its CSRF check):
    // this one comes from no other site's page, so it names the app's own origin.
    origin: target.app.origin,
    [ACTOR_HEADER]: encodeURIComponent(person),
    ...(options.agent !== undefined && { [AGENT_HEADER]: encodeURIComponent(options.agent.trim()) }),
  };
  const until = Date.now() + RESULT_DEADLINE_MS;
  if (result) stopOnInterrupt(input);
  for (;;) {
    const sent = Date.now();
    const answer = await send(target, headers, body);
    if (answer.ok) {
      process.stdout.write(`${JSON.stringify(answer.body, null, process.stdout.isTTY ? 2 : undefined)}\n`);
      return 0;
    }
    if (result && answer.problem?.code === "run_running" && Date.now() < until) {
      // A second at least between two requests, whatever the run's wait was.
      const wait = Math.min(RETRY_MS - (Date.now() - sent), until - Date.now());
      if (wait > 0) await sleep(wait);
      continue;
    }
    throw new Error(failure(target, answer, result));
  }
}

/**
 * A ctrl-c while a `.result` waits: stops asking (exit 130), saying the run goes on. The run is
 * the app's, which nothing here stops.
 */
function stopOnInterrupt(input: unknown): void {
  const runId = (input as { runId?: unknown } | undefined)?.runId;
  process.once("SIGINT", () => {
    process.stderr.write(
      `stopped waiting${typeof runId === "string" ? `: run ${clean(runId)} goes on, ask again for its result` : ""}\n`,
    );
    process.exit(130);
  });
}

/** An error body as `/api/call` answers it (`ErrorResponse`). */
interface Problem {
  error?: string;
  code?: string;
  runId?: string;
  issues?: { path?: (string | number)[]; message?: string }[];
}

/** What the app answered that is no answer of the call's: its status, its body as text, and as an error body when it is one. */
interface Failed {
  ok: false;
  status: number;
  problem?: Problem;
  text: string;
}

type Answer = { ok: true; body: unknown } | Failed;

/**
 * Errors after which the app may have taken the request: its connection broken once open. Any
 * other (nothing listens, no such host, a URL fetch refuses) is raised before anything is sent.
 */
const MAYBE_SENT = new Set(["UND_ERR_SOCKET", "UND_ERR_CLOSED", "ECONNRESET", "EPIPE", "ECONNABORTED", "ETIMEDOUT"]);

/**
 * One `POST /api/call`: the answer, or an error naming the address (and where it came from) when
 * nothing answers in time; for a call with an `id`, how to make the same call again.
 */
async function send(
  target: Target,
  headers: Record<string, string>,
  body: { name: string; id?: string },
): Promise<Answer> {
  const { app, from } = target;
  const { id } = body;
  const again =
    id === undefined
      ? ""
      : `\nThe call's id was ${id}: running the command again with --id ${id} is the same call, not a second one`;
  const timedOut = () =>
    new Error(`The app at ${app.origin} did not answer in ${REQUEST_TIMEOUT_MS / 1000} s${from}${again}`);
  let res: Response;
  let text: string;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    res = await fetch(new URL("/api/call", app), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // A redirect is no answer of the api's (a host's sign-in page, say), and would carry the headers elsewhere.
      redirect: "manual",
      signal,
    });
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "TimeoutError") throw timedOut();
    const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
    const sentMaybe = MAYBE_SENT.has(cause?.code ?? "");
    throw new Error(
      `Nothing answers at ${app.origin} (${cause?.code ?? cause?.message ?? errorMessage(err)})${from}: ` +
        `start the app with sanoma, or name where it runs with --url${sentMaybe ? again : ""}`,
      { cause: err },
    );
  }
  try {
    // The same deadline for the body: an answer that stalls after its headers is no answer.
    text = await res.text();
  } catch (err) {
    if (signal.aborted) throw timedOut();
    throw new Error(`The app at ${app.origin} broke off its answer (${errorMessage(err)})${again}`, { cause: err });
  }
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

/** The text of the server's that is printed, without control characters (C0 but newline and tab, DEL, C1: a terminal's escapes). */
// oxlint-disable-next-line no-control-regex -- the control characters are what it removes
const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

/** A string of the server's, cleaned (`clean`); undefined for anything else. */
const str = (value: unknown) => (typeof value === "string" ? clean(value) : undefined);

/** The message a refused or failed call exits 1 with: the app's error, its code, the run, the input's issues. */
function failure(target: Target, { status, problem, text }: Failed, result: boolean): string {
  const { app } = target;
  const lines: string[] = [];
  const error = str(problem?.error);
  const code = str(problem?.code);
  const runId = str(problem?.runId);
  if (error) {
    lines.push(`${error}${code ? ` (${code})` : ""}`);
  } else if (status >= 300 && status < 400) {
    lines.push(`The app at ${app.origin} answered with a redirect (HTTP ${status}), not an answer of its api`);
  } else {
    const said = clean(text.trim().slice(0, 200));
    lines.push(`The app at ${app.origin} answered HTTP ${status}${said ? `: ${said}` : ""}`);
  }
  if (runId) {
    lines.push(
      code === "run_running" && result
        ? `run ${runId} has not ended in ${RESULT_DEADLINE_MS / 60_000} minutes: ask again for its result`
        : `run ${runId}`,
    );
  }
  for (const issue of Array.isArray(problem?.issues) ? problem.issues : []) {
    const path = Array.isArray(issue?.path) && issue.path.length ? clean(issue.path.join(".")) : "(the input)";
    lines.push(`  ${path}: ${str(issue?.message) ?? "invalid"}`);
  }
  // A host's app says who is asking from its sign-in, which these commands do not give.
  const refused = (status >= 300 && status < 400) || status === 401 || status === 403;
  if (refused && !isLoopback(app.hostname)) {
    lines.push(
      `${app.host} is not this machine: sanoma call and sanoma describe sign in only to an app on this machine, and a hosted app's sign-in refuses them`,
    );
  } else if (target.signIn !== undefined && (refused || status === 400)) {
    lines.push(
      `The app at ${app.origin} listens beyond this machine (${target.signIn}), so it signs people in with the staff login, which sanoma call and sanoma describe do not; run it on 127.0.0.1 to call it from here`,
    );
  }
  return lines.join("\n");
}

/**
 * The company the commands work for, from `cwd`: the root whose running app they ask, and whose
 * `.env` and people they read, as that app reads them. Its candidates are the nearest directory
 * with a `sanoma.config.ts` (`configDirOf`: an app in `apps/<app>/` that kept its own config, run
 * there on its own), then the company's root (`companyRootOf`), each as its main checkout has it
 * (`mainCheckout`: a draft in `.sanoma/drafts/<id>` is its company's); the first with a live
 * `.sanoma/app.json` (`runningApp`) is the one, else the company's root. Undefined outside any.
 */
async function companyOf(cwd: string) {
  const { companyRootOf, configDirOf } = await import("sanoma/workflows/describe");
  const found = [configDirOf(cwd), companyRootOf(cwd)].filter((dir) => dir !== undefined);
  const roots = [...new Set(await Promise.all(found.map(mainCheckout)))];
  for (const root of roots) {
    const app = runningApp(root);
    if (app) return { root, running: { ...app, file: join(root, APP_FILE) } };
  }
  return { root: roots.at(-1), running: undefined };
}

/**
 * Where the app listens: `--url`; else the app a company's `.sanoma/app.json` names while its
 * process runs (`running`, from `companyOf`: an http(s) URL on this machine, written by `sanoma`,
 * `sanoma serve` and `sanoma app` when they listen, saying when the app signs people in); else `SANOMA_APP_HOST` (default 127.0.0.1) and
 * `SANOMA_APP_PORT` (default 3000; empty or 0, any free port, as the app reads it, says nothing of
 * where: a `UsageError` asking for `--url`), the `.env` loaded. 0.0.0.0 and :: are asked at this
 * machine's address, where such an app answers too, but an app on any address but this machine's
 * signs people in with the staff login, which refuses these commands: the failure says so.
 */
function targetOf(url: string | undefined, running: { url: string; file: string; signIn?: true } | undefined): Target {
  if (url !== undefined) {
    const parsed = URL.parse(url);
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      throw new UsageError(`--url: "${url}" is not an http(s) URL, such as http://127.0.0.1:3000`);
    }
    // Refused before fetch is, which would print them: these commands say who asks with --as.
    if (parsed.username || parsed.password) {
      throw new UsageError("--url names a user or a password: leave them out, and say who is asking with --as");
    }
    return { app: parsed, from: "" };
  }
  if (running) {
    return {
      app: new URL(running.url),
      from: `; the address is the one ${running.file} names`,
      ...(running.signIn && { signIn: `${running.file} says so` }),
    };
  }
  // As the app reads them (`appAddress`): an empty port is 0, any free port.
  const { host: named, port } = appAddress();
  if (port === 0) {
    throw new UsageError(
      "SANOMA_APP_PORT is 0 or empty, any free port, and no running app here says which: name the app's address with --url (sanoma prints it)",
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new UsageError(`SANOMA_APP_PORT is "${process.env.SANOMA_APP_PORT}", which is no port`);
  }
  const host = named === "0.0.0.0" ? "127.0.0.1" : named === "::" ? "::1" : named;
  const app = new URL(`http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`);
  return {
    app,
    from: "; the address is SANOMA_APP_HOST's and SANOMA_APP_PORT's",
    ...(!isLoopback(named) && { signIn: `SANOMA_APP_HOST is ${named}` }),
  };
}

/**
 * Who is asking, by a declared person's id: `--as` (a declared id, else an email or a GitHub login,
 * matched with `personOf`, when people are declared; with none, taken as it is); else the one person declared, as
 * the app's picker takes them; else the one git's `user.email` names. Otherwise a `UsageError`
 * listing the declared ids. The people are read from the company's `resources/` (`readPeople`,
 * imported only here); outside a company (`root` undefined), `--as` is needed.
 */
async function personAsking(as: string | undefined, root: string | undefined): Promise<string> {
  const named = as?.trim();
  if (as !== undefined && !named) throw new UsageError("--as names nobody");
  if (root === undefined) {
    if (named) return named;
    throw new UsageError("No company here to read the people of: say who is asking with --as <id>");
  }
  const { readPeople } = await import("sanoma/workflows/describe");
  let declared: ReturnType<typeof readPeople>["people"];
  try {
    declared = readPeople(root).people;
  } catch (err) {
    // The app reads them too, and refuses whom they do not admit.
    if (named) return named;
    throw new Error(`Could not read the people in ${root}/resources: ${errorMessage(err)}`, { cause: err });
  }
  const people = personsOf(declared);
  const ids = people.map((p) => p.id).join(", ");
  if (named) {
    if (!people.length) return named;
    // A declared id is that person, before anyone's email or GitHub login that happens to read the same.
    const id = people.find((p) => p.id === named)?.id ?? personOf({ email: named, github: named }, declared);
    if (id) return id;
    throw new UsageError(`--as: ${named} is no declared person; the people are ${ids}`);
  }
  if (!people.length) throw new UsageError("No person is declared in resources/: say who is asking with --as <id>");
  if (people.length === 1) return people[0]!.id;
  const email = gitEmail(root);
  const id = email && personOf({ email }, declared);
  if (id) return id;
  throw new UsageError(
    `Say who is asking with --as <id, email or GitHub login>: the people are ${ids}` +
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
