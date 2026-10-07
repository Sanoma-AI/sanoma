import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ApprovalState,
  describeConfig,
  resolveDatabaseUrl,
  SanomaClient,
  type SanomaConfig,
} from "@sanoma/workflows";
import { ACTOR_HEADER, type DecideRequest, type ErrorResponse, type RunDetail, type StartRunResponse } from "./api.ts";

export interface AppOptions {
  /** Defaults to 0: any free port, which `App.url` reports. 4321 is the suggested fixed port. */
  port?: number;
  /**
   * Defaults to 127.0.0.1, so only this machine can reach the app. There is no login:
   * anyone who can reach it can start runs and decide approvals as any name.
   */
  host?: string;
  /** The built page. Defaults to the one this package ships. */
  uiDir?: string;
}

export interface App {
  /** Where the app listens, such as `http://127.0.0.1:4321`. */
  url: string;
  close(): Promise<void>;
}

/**
 * Serves a web UI over a config: its runs, their ledgers and approvals, and a form to start
 * each workflow. Reads the same config the worker runs, through Postgres and the config's
 * ledger store; it runs no workflows itself.
 */
export async function startApp(config: SanomaConfig, options: AppOptions = {}): Promise<App> {
  const description = describeConfig(config);
  const uiDir = resolve(options.uiDir ?? defaultUiDir());
  const host = options.host ?? "127.0.0.1";
  const client = await SanomaClient.connect(resolveDatabaseUrl(config), {
    appName: config.appName,
    ledger: config.ledger,
  });

  const routes: Route[] = [
    route("GET", "/api/config", async () => ok(description)),
    route("GET", "/api/runs", async ({ url }) => ok(await client.runs(limitOf(url)))),
    route("GET", "/api/runs/:id", async (r) => ok(await runDetail(param(r, "id")))),
    route("POST", "/api/runs", startRun),
    route("POST", "/api/runs/:id/approvals/:approvalId", decide),
  ];

  async function runDetail(runId: string): Promise<RunDetail> {
    const run = await client.run(runId);
    if (!run) throw new HttpError(404, `No run ${runId}`);
    const [ledger, approvals] = await Promise.all([readLedger(runId), client.approvals(runId)]);
    return { run, ...ledger, approvals };
  }

  async function readLedger(runId: string): Promise<Pick<RunDetail, "ledger" | "ledgerError">> {
    if (!config.ledger) return { ledger: null };
    try {
      return { ledger: await client.ledger(runId) };
    } catch (err) {
      // A JSONL ledger whose directory no run has written to yet throws; the run still shows.
      console.error(`sanoma app: could not read the ledger of run ${runId}:`, err);
      return { ledger: [], ledgerError: errorMessage(err) };
    }
  }

  async function startRun(r: Request): Promise<Reply> {
    const actor = actorOf(r.req);
    const body = await readJson(r.req);
    if (!isRecord(body) || typeof body.workflow !== "string") {
      throw new HttpError(400, 'Send {"workflow": name, "input": {...}}');
    }
    const workflow = config.workflows.find((wf) => wf.name === body.workflow);
    if (!workflow) throw new HttpError(404, `No workflow named "${body.workflow}"`);
    try {
      const runId = await client.start(workflow, body.input, { startedBy: actor });
      return { status: 201, body: { runId } satisfies StartRunResponse };
    } catch (err) {
      if (isSchemaError(err)) {
        throw new HttpError(400, `The input does not match ${workflow.name}'s schema`, {
          issues: err.issues.map(({ path, message, code }) => ({
            path: path.filter((p) => typeof p !== "symbol"),
            message,
            code,
          })),
        });
      }
      throw err;
    }
  }

  async function decide(r: Request): Promise<Reply> {
    const actor = actorOf(r.req);
    const runId = param(r, "id");
    const approvalId = param(r, "approvalId");
    const body = await readJson(r.req);
    if (
      !isRecord(body) ||
      (body.decision !== "approve" && body.decision !== "reject") ||
      (body.note !== undefined && typeof body.note !== "string")
    ) {
      throw new HttpError(400, 'Send {"decision": "approve" | "reject", "note"?: string}');
    }
    const { decision } = body as unknown as DecideRequest;
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined;

    if (!(await client.run(runId))) throw new HttpError(404, `No run ${runId}`);
    const approval = (await client.approvals(runId)).find((a) => a.id === approvalId);
    if (!approval) throw new HttpError(404, `Run ${runId} has no approval "${approvalId}"`);
    if (approval.status !== "pending") {
      throw new HttpError(409, `${approvalId} was already ${approval.status} by ${approval.decidedBy}`);
    }
    try {
      await client.decide(
        runId,
        note === undefined ? { decision, by: actor } : { decision, by: actor, note },
        approvalId,
      );
    } catch (err) {
      // SanomaClient refuses before sending; these are its messages.
      const message = errorMessage(err);
      if (message.includes("is not the approver")) throw new HttpError(403, message, { approver: approval.approver });
      if (message.includes("has no pending approval") || message.startsWith("No run ")) {
        throw new HttpError(404, message);
      }
      if (message.includes("was already")) throw new HttpError(409, message);
      throw err;
    }
    return ok((await settled(client, runId, approvalId)) ?? approval);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error("sanoma app: request failed:", err);
      if (res.headersSent) res.destroy();
      else send(res, 500, { error: "Internal error" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://app.invalid");
    if (isLoopback(host) && !isLoopbackHost(req.headers.host)) {
      // A page on another site can point its own hostname at 127.0.0.1 (DNS rebinding). Refuse it.
      return send(res, 403, { error: `This app answers to localhost only, not ${req.headers.host ?? "no host"}` });
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const reply = await api(routes, req, url);
      return send(res, reply.status, reply.body);
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, { error: `${req.method} is not allowed here` });
    }
    await servePage(res, uiDir, url.pathname);
  }

  try {
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(options.port ?? 0, host, () => {
        server.off("error", fail);
        done();
      });
    });
  } catch (err) {
    await client.close();
    throw err;
  }

  const address = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${urlHost(address)}:${address.port}`,
    close() {
      closing ??= (async () => {
        await new Promise<void>((done, fail) => {
          server.close((err) => (err ? fail(err) : done()));
          server.closeAllConnections();
        });
        await client.close();
      })();
      return closing;
    },
  };
}

// --- Routing ---------------------------------------------------------------------------------

interface Request {
  req: IncomingMessage;
  url: URL;
  params: Record<string, string>;
}

interface Reply {
  status: number;
  body: unknown;
}

interface Route {
  method: "GET" | "POST";
  pattern: RegExp;
  keys: string[];
  handler: (r: Request) => Promise<Reply>;
}

/** A route such as `/api/runs/:id`: each `:name` matches one path segment. */
function route(method: Route["method"], path: string, handler: Route["handler"]): Route {
  const keys: string[] = [];
  const source = path.replace(/:(\w+)/g, (_, key: string) => {
    keys.push(key);
    return "([^/]+)";
  });
  return { method, pattern: new RegExp(`^${source}$`), keys, handler };
}

const ok = (body: unknown): Reply => ({ status: 200, body });

class HttpError extends Error {
  readonly status: number;
  readonly extra: Omit<ErrorResponse, "error">;

  constructor(status: number, message: string, extra: Omit<ErrorResponse, "error"> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.extra = extra;
  }
}

/** Runs the matching route. Every error becomes a JSON reply; unexpected ones are logged. */
async function api(routes: Route[], req: IncomingMessage, url: URL): Promise<Reply> {
  try {
    const matches = routes.flatMap((r) => {
      const m = r.pattern.exec(url.pathname);
      return m ? [{ r, m }] : [];
    });
    if (!matches.length) throw new HttpError(404, `No API route ${url.pathname}`);
    const match = matches.find(({ r }) => r.method === req.method);
    if (!match) throw new HttpError(405, `${req.method} is not allowed on ${url.pathname}`);
    const params: Record<string, string> = {};
    match.r.keys.forEach((key, i) => {
      try {
        params[key] = decodeURIComponent(match.m[i + 1] ?? "");
      } catch {
        throw new HttpError(400, `Bad ${key} in the path`);
      }
    });
    return await match.r.handler({ req, url, params });
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, body: { error: err.message, ...err.extra } };
    console.error(`sanoma app: ${req.method} ${url.pathname} failed:`, err);
    return { status: 500, body: { error: errorMessage(err) } satisfies ErrorResponse };
  }
}

function param(r: Request, key: string): string {
  const value = r.params[key];
  if (value === undefined) throw new Error(`Route has no :${key}`);
  return value;
}

function limitOf(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 50;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `limit must be a positive whole number, not "${raw}"`);
  return Math.min(n, 500);
}

/** The name in the actor header. The page sends it URI-encoded so any name fits in a header. */
function actorOf(req: IncomingMessage): string {
  const raw = req.headers[ACTOR_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  let actor = value ?? "";
  try {
    actor = decodeURIComponent(actor);
  } catch {
    // Not URI-encoded: take it as sent.
  }
  actor = actor.trim();
  if (!actor) throw new HttpError(400, `Say who you are in the ${ACTOR_HEADER} header`);
  return actor;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, "The body is over 1 MB");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) throw new HttpError(400, "The body is empty; send JSON");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "The body is not JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(json);
}

// --- Decisions ---------------------------------------------------------------------------------

/** The approval once the run has read the decision, or as it stands after a few seconds. */
async function settled(client: SanomaClient, runId: string, approvalId: string): Promise<ApprovalState | undefined> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const approval = (await client.approvals(runId)).find((a) => a.id === approvalId);
    if (!approval || approval.status !== "pending" || Date.now() > deadline) return approval;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Matched by name, since the workflow's schema may come from another copy of zod.
function isSchemaError(err: unknown): err is Error & {
  issues: { path: PropertyKey[]; message: string; code?: string }[];
} {
  return err instanceof Error && err.name === "ZodError" && Array.isArray((err as { issues?: unknown }).issues);
}

// --- The page ----------------------------------------------------------------------------------

/** Published, this module is dist/index.js beside dist/ui. In the repo it runs from src/, and the page builds to dist/ui. */
function defaultUiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return basename(here) === "src" ? join(here, "..", "dist", "ui") : join(here, "ui");
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** A file from the built page, or its index.html for any other path (the page routes by hash). */
async function servePage(res: ServerResponse, uiDir: string, pathname: string) {
  const index = join(uiDir, "index.html");
  if (!(await isFile(index))) {
    return send(res, 503, { error: "UI not built" });
  }
  let file = index;
  let decoded: string | undefined;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = undefined;
  }
  if (decoded && decoded !== "/") {
    const candidate = resolve(uiDir, `.${decoded}`);
    const rel = relative(uiDir, candidate);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel) && (await isFile(candidate))) file = candidate;
  }
  const body = await readFile(file);
  // Vite names built assets by content hash, so they never change; index.html must be re-read.
  const immutable = file !== index && relative(uiDir, file).startsWith("assets");
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": body.length,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// --- Helpers -----------------------------------------------------------------------------------

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopback(host: string): boolean {
  return LOOPBACK.has(host) || host.startsWith("127.");
}

/** True when the Host header names this machine: localhost, 127.x.x.x or [::1], with any port. */
function isLoopbackHost(header: string | undefined): boolean {
  if (!header) return false;
  const name = header.startsWith("[") ? header.slice(1, header.indexOf("]")) : header.replace(/:\d+$/, "");
  return isLoopback(name.toLowerCase());
}

function urlHost({ address, family }: AddressInfo): string {
  if (address === "0.0.0.0" || address === "::") return "localhost";
  return family === "IPv6" ? `[${address}]` : address;
}
