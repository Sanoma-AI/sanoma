import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ParsedKey, Server, utils } from "ssh2";
import { createWebSocketStream, WebSocketServer } from "ws";

// Agent37 on this machine, for the backend's tests: its Sandbox API as a `fetch` that answers
// `https://api.agent37.com/v1` from memory (every other URL goes out), and its SSH server behind
// a WebSocket, as Agent37's edge has one, whose commands are `bash -c` children here, each
// instance's home a directory of its own. `answer` puts a reply ahead of the next request.

export const KEY = "sk_live_test";

export interface FakeInstance {
  id: string;
  status: string;
  name: string;
  metadata: Record<string, string> | null;
  template: string;
  resources: { cpu: number; memory: number; disk: number };
  type: string;
  region: string;
  auto_sleep: boolean;
  idle_timeout_seconds: number;
}

export interface Sent {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const problem = (status: number, code: string) => json(status, { error: { code, message: code } });

export async function fakeAgent37Vendor() {
  const root = mkdtempSync(join(tmpdir(), "sanoma-agent37-"));
  const instances = new Map<string, FakeInstance>();
  const keys: ParsedKey[] = [];
  const sent: Sent[] = [];
  /** Replies to give before the API answers, in order, each to the first request it matches. */
  const answers: { method: string; path: string; status: number; body: unknown }[] = [];
  let seq = 0;
  const home = (id: string) => join(root, id);

  function api(method: string, path: string, body: Record<string, any> | undefined): Response {
    const answered = answers.findIndex((a) => a.method === method && a.path === path);
    if (answered >= 0) {
      const { status, body: reply } = answers.splice(answered, 1)[0]!;
      return json(status, reply);
    }
    if (method === "GET" && path === "/instances") return json(200, { data: [...instances.values()].toReversed() });
    if (method === "POST" && path === "/instances") {
      const id = `fake${String(++seq).padStart(6, "0")}`;
      const made: FakeInstance = {
        id,
        status: "running",
        name: body!.name,
        metadata: body!.metadata ?? null,
        template: body!.template,
        resources: body!.resources,
        type: body!.type,
        region: body!.region,
        auto_sleep: body!.auto_sleep,
        idle_timeout_seconds: body!.idle_timeout_seconds,
      };
      instances.set(id, made);
      mkdirSync(home(id), { recursive: true });
      return json(201, made);
    }
    if (method === "POST" && path === "/ssh-keys") {
      const parsed = utils.parseKey(body!.public_key) as ParsedKey;
      if (keys.some((k) => k.getPublicSSH().equals(parsed.getPublicSSH()))) return problem(409, "ssh_key_exists");
      keys.push(parsed);
      return json(201, { id: `key${keys.length}`, name: body!.name, type: parsed.type });
    }
    const [, id, action] = path.match(/^\/instances\/([^/]+)(?:\/(\w+))?$/) ?? [];
    const found = id ? instances.get(id) : undefined;
    if (!found) return problem(404, "not_found");
    if (method === "GET" && !action) return json(200, found);
    if (method === "DELETE" && !action) {
      instances.delete(found.id);
      rmSync(home(found.id), { recursive: true, force: true });
      return json(200, { id: found.id, deleted: true });
    }
    const to = { start: "running", sleep: "sleeping", stop: "stopped" }[action as string];
    if (method === "POST" && to) {
      const from = {
        start: ["stopped", "sleeping", "running"],
        sleep: ["running", "sleeping"],
        stop: ["running", "sleeping", "stopped"],
      }[action!]!;
      if (!from.includes(found.status)) return problem(400, "invalid_request");
      found.status = to;
      return json(200, { id: found.id, status: to });
    }
    return problem(404, "not_found");
  }

  const realFetch = globalThis.fetch;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.host !== "api.agent37.com") return realFetch(input, init);
    const path = url.pathname.replace(/^\/v1/, "");
    const text = await request.text();
    const body = text ? JSON.parse(text) : undefined;
    sent.push({ method: request.method, path, ...(body && { body }) });
    if (request.headers.get("authorization") !== `Bearer ${KEY}`) return problem(401, "invalid_api_key");
    return api(request.method, path, body);
  };

  // An SSH server per instance: a session's exec is `bash -c` here, in the instance's home.
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const servers = new Map<string, Server>();
  const serverOf = (id: string) => {
    let server = servers.get(id);
    if (server) return server;
    server = new Server({ hostKeys: [hostKey] }, (client) => {
      client.on("authentication", (ctx) => {
        const key = ctx.method === "publickey" && keys.find((k) => k.getPublicSSH().equals(ctx.key.data));
        if (!key || ctx.method !== "publickey" || ctx.username !== "node") return ctx.reject(["publickey"]);
        if (ctx.signature && !key.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) return ctx.reject(["publickey"]);
        ctx.accept();
      });
      client.on("session", (accept) => {
        accept().on("exec", (start, _reject, { command }) => {
          const channel = start();
          const child = spawn("bash", ["-c", command], {
            cwd: "/",
            env: { HOME: home(id), PATH: [dirname(process.execPath), process.env.PATH].join(":") },
          });
          child.stdin.on("error", () => {});
          channel.pipe(child.stdin);
          child.stdout.pipe(channel, { end: false });
          child.stderr.pipe(channel.stderr);
          child.on("close", (code, signal) => {
            channel.exit(code ?? 128 + (signal ? constants.signals[signal] : 1));
            channel.end();
          });
        });
      });
      client.on("error", () => {});
    });
    servers.set(id, server);
    return server;
  };
  const headersSeen: string[] = [];
  const edge = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  edge.on("connection", (ws, req) => {
    headersSeen.push(String(req.headers["x-agent37-key"]));
    const id = (req.url ?? "").slice(1);
    if (req.headers["x-agent37-key"] !== KEY || instances.get(id)?.status !== "running") return ws.close();
    serverOf(id).injectSocket(createWebSocketStream(ws) as never);
  });
  await new Promise((resolve) => edge.once("listening", resolve));
  const port = (edge.address() as AddressInfo).port;

  return {
    instances,
    keys,
    sent,
    headersSeen,
    fetch,
    home,
    /** Gives `reply` to the next `method path` request, ahead of the API. */
    answer: (method: string, path: string, status: number, body: unknown) =>
      answers.push({ method, path, status, body }),
    /** Where a port of an instance is: its SSH server's through the edge, any other this machine's. */
    edge: (id: string, at: number) => (at === 22022 ? `http://127.0.0.1:${port}/${id}` : `http://127.0.0.1:${at}`),
    async close() {
      await new Promise((resolve) => edge.close(resolve));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
