import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RUNNER_HEALTH, RUNNER_PORT } from "sanoma/workflows";

// Agent37 on this machine, for the backend's tests: its Sandbox API as a `fetch` that answers
// `https://api.agent37.com/v1` from memory (every other URL goes out), its exec `sh -c` here, each
// instance's home a directory of its own, and its edge a port of this machine per instance's port:
// the runner the backend starts with exec listens on one of its own (`SANOMA_RUNNER_PORT`). Its
// workspace templates are names in memory, an image registered at once. Every key that starts
// with `KEY` is one of its workspace's, so a test may use a key of its own. Its
// `PATH` is a template's: no pnpm, but a corepack that makes one. A stop, a delete and `close` end
// what an instance's execs left running, as a fresh boot would; a sleep keeps it. The edge answers
// `/health` itself, on every port, as Agent37's does. `answer` puts a reply ahead of the next
// request.

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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-agent37-")));
  const instances = new Map<string, FakeInstance>();
  /** The workspace's templates, by name: what was registered. */
  const templates = new Map<string, { name: string; image_ref: string }>();
  /** Each instance's runner port, and the process groups its execs led. */
  const runners = new Map<string, { port: number; groups: number[] }>();
  const sent: Sent[] = [];
  /** Replies to give before the API answers, in order, each to the first request it matches. */
  const answers: { method: string; path: string; status: number; body: unknown }[] = [];
  let seq = 0;
  const home = (id: string) => join(root, id);
  // The template's own programs: node, and corepack as far as the backend uses it.
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  writeFileSync(
    join(bin, "corepack"),
    `#!/bin/sh
[ "$1 $2 $4" = "enable --install-directory pnpm" ] || { echo "corepack: not faked: $*" >&2; exit 1; }
printf '#!/bin/sh\\necho 12.18.0\\n' > "$3/pnpm" && chmod +x "$3/pnpm"
`,
    { mode: 0o755 },
  );
  /** This machine's `PATH` but where a pnpm is, as a template has none. */
  const searched = (process.env.PATH ?? "").split(":").filter((dir) => dir && !existsSync(join(dir, "pnpm")));

  /**
   * Ends what the instance's execs left running (its runner, which ends what it started), and
   * waits until its runner no longer answers.
   */
  async function boot(id: string) {
    const runner = runners.get(id);
    if (!runner) return;
    for (const group of runner.groups.splice(0)) {
      try {
        process.kill(-group, "SIGTERM");
      } catch {
        // Gone already.
      }
    }
    while (await listening(runner.port)) await delay(50);
  }
  const listening = (port: number) =>
    realFetch(`http://127.0.0.1:${port}${RUNNER_HEALTH}`).then(
      () => true,
      () => false,
    );

  /** Runs `command` as exec does, `sh -c` as the instance's user, with none of this process's environment. */
  function exec(id: string, command: string): Promise<Response> {
    const runner = runners.get(id)!;
    const child = spawn("sh", ["-c", command], {
      cwd: "/",
      env: {
        HOME: home(id),
        PATH: [join(home(id), ".local/bin"), bin, ...searched].join(":"),
        SANOMA_RUNNER_HOST: "127.0.0.1",
        SANOMA_RUNNER_PORT: String(runner.port),
      },
      // A group of its own, which a stop or a delete ends.
      detached: true,
    });
    runner.groups.push(child.pid!);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    return new Promise((done) =>
      child.on("close", (code) =>
        done(
          json(200, {
            exit_code: code ?? 1,
            stdout: Buffer.concat(out).toString(),
            stderr: Buffer.concat(err).toString(),
          }),
        ),
      ),
    );
  }

  async function api(method: string, path: string, body: Record<string, any> | undefined): Promise<Response> {
    const answered = answers.findIndex((a) => a.method === method && a.path === path);
    if (answered >= 0) {
      const { status, body: reply } = answers.splice(answered, 1)[0]!;
      return json(status, reply);
    }
    if (method === "GET" && path === "/instances") return json(200, { data: [...instances.values()].toReversed() });
    if (method === "POST" && path === "/templates") {
      if (templates.has(body!.name)) return problem(409, "template_conflict");
      const made = { name: body!.name, image_ref: body!.image_ref };
      templates.set(made.name, made);
      return json(201, made);
    }
    const template = path.match(/^\/templates\/([^/]+)$/)?.[1];
    if (method === "GET" && template) {
      const found = templates.get(template);
      return found ? json(200, found) : problem(404, "not_found");
    }
    if (method === "POST" && path === "/instances") {
      const id = `fake${String(++seq).padStart(6, "0")}`;
      const made: FakeInstance = { ...body!, id, status: "running", metadata: body!.metadata ?? null } as FakeInstance;
      instances.set(id, made);
      runners.set(id, { port: await freePort(), groups: [] });
      mkdirSync(home(id), { recursive: true });
      return json(201, made);
    }
    const [, id, action] = path.match(/^\/instances\/([^/]+)(?:\/(\w+))?$/) ?? [];
    const found = id ? instances.get(id) : undefined;
    if (!found) return problem(404, "not_found");
    if (method === "GET" && !action) return json(200, found);
    if (method === "DELETE" && !action) {
      await boot(found.id);
      instances.delete(found.id);
      runners.delete(found.id);
      rmSync(home(found.id), { recursive: true, force: true });
      return json(200, { id: found.id, deleted: true });
    }
    if (method === "POST" && action === "exec") {
      // A sleeping instance is woken first.
      if (found.status === "sleeping") found.status = "running";
      if (found.status !== "running") return problem(400, "invalid_request");
      return exec(found.id, body!.command);
    }
    const move = {
      start: { to: "running", from: ["stopped", "sleeping", "running"] },
      sleep: { to: "sleeping", from: ["running", "sleeping"] },
      stop: { to: "stopped", from: ["running", "sleeping", "stopped"] },
    }[action as string];
    if (method === "POST" && move) {
      const { to, from } = move;
      if (!from.includes(found.status)) return problem(400, "invalid_request");
      // A stopped instance boots fresh: its disk is kept, its processes are not.
      if (action === "stop") await boot(found.id);
      found.status = to;
      return json(200, { id: found.id, status: to });
    }
    return problem(404, "not_found");
  }

  const realFetch = globalThis.fetch;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.host !== "api.agent37.com") {
      // The edge's: it answers `/health` itself, and keeps what the runner's health check carried.
      if (url.pathname === "/health") return json(200, { ok: true });
      if (url.pathname === RUNNER_HEALTH) headersSeen.push(String(request.headers.get("x-agent37-key")));
      return realFetch(input, init);
    }
    const path = url.pathname.replace(/^\/v1/, "");
    const text = await request.text();
    const body = text ? JSON.parse(text) : undefined;
    sent.push({ method: request.method, path, ...(body && { body }) });
    if (!request.headers.get("authorization")?.startsWith(`Bearer ${KEY}`)) return problem(401, "invalid_api_key");
    return api(request.method, path, body);
  };
  const headersSeen: string[] = [];

  return {
    instances,
    templates,
    sent,
    headersSeen,
    fetch,
    home,
    /** Gives `reply` to the next `method path` request, ahead of the API. */
    answer: (method: string, path: string, status: number, body: unknown) =>
      answers.push({ method, path, status, body }),
    /** Where a port of an instance is: its runner's own port for 7700, any other this machine's. */
    edge: (id: string, at: number) => `http://127.0.0.1:${at === RUNNER_PORT ? (runners.get(id)?.port ?? 1) : at}`,
    async close() {
      await Promise.all([...runners.keys()].map(boot));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A port nothing listens on, for now. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.once("error", reject);
  });
