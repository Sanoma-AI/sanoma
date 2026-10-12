import * as childProcess from "node:child_process";
import { createServer } from "node:net";
import { testDatabaseUrl } from "@sanoma/testing";
import * as pg from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ensurePostgres, masked } from "../src/postgres.ts";

// `execFile` (Docker) and pg's `Client` (the probe) are the real ones unless a test stubs them:
// the stubs answer as Docker and Postgres would, and fake timers stand in for the wait. The
// last describe runs real Docker, when it is installed.
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, execFile: vi.fn<typeof real.execFile>(real.execFile) };
});
vi.mock("pg", async (importOriginal) => {
  const real = await importOriginal<typeof import("pg")>();
  return {
    ...real,
    Client: vi.fn<(config: pg.ClientConfig) => pg.Client>(function (config) {
      return new real.Client(config);
    }),
  };
});

const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

/**
 * Stubs Docker, `inspect` answering as `state` says, and the probe, which answers once Postgres
 * would: after `run` or `start`, or, for a container already running (still starting up, since
 * the probe did not answer before), after `inspect`; never, with `never`. Returns the calls.
 */
function stub(state: "running" | "stopped" | "missing" | "no docker", { never = false } = {}): string[][] {
  const calls: string[][] = [];
  let up = false;
  vi.mocked(childProcess.execFile).mockImplementation(((
    _file: string,
    args: string[],
    callback: (err: Error | null, stdout?: string) => void,
  ) => {
    calls.push(args);
    if (state === "no docker") {
      callback(Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));
    } else if (args[0] === "inspect") {
      if (state === "running") up = true;
      if (state === "missing") callback(new Error("Error: No such object"));
      else callback(null, `${state === "running"}\n`);
    } else {
      up = true;
      callback(null, "abc123\n");
    }
  }) as unknown as typeof childProcess.execFile);
  vi.mocked(pg.Client).mockImplementation(function () {
    return {
      connect: async () => {
        if (!up || never) throw refused();
      },
      query: async () => ({}),
      end: async () => {},
    } as unknown as pg.Client;
  } as unknown as typeof pg.Client);
  return calls;
}

const local = "postgresql://postgres:dbos@127.0.0.1:65000/sanoma_test";

// Back to the real Docker and pg after each stub (a vi.fn's reset is its original implementation).
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(childProcess.execFile).mockReset();
  vi.mocked(pg.Client).mockReset();
});

describe("ensurePostgres", () => {
  it("answers when Postgres is there", async () => {
    const log: string[] = [];
    const url = testDatabaseUrl("sanoma-pg");
    await expect(ensurePostgres(url, { appName: "x", log: (l) => log.push(l) })).resolves.toEqual({ how: "answered" });
    expect(log).toEqual([`Postgres answers at ${masked(url)}`]);
  });

  it("starts Postgres only for this machine: localhost, 127.x.x.x and ::1; elsewhere it names the URL without its password", async () => {
    for (const host of ["localhost", "127.1.2.3", "[::1]"]) {
      const calls = stub("missing");
      await expect(ensurePostgres(`postgresql://u:p@${host}:65000/x`, { appName: "x" })).resolves.toMatchObject({
        how: "created",
      });
      expect(calls[0]![0], host).toBe("inspect");
    }
    const calls = stub("missing");
    await expect(ensurePostgres("postgresql://u:p@10.255.255.1:5432/x", { appName: "x" })).rejects.toThrow(
      "nothing answers at postgresql://u:***@10.255.255.1:5432/x; start Postgres or set SANOMA_DATABASE_URL",
    );
    expect(calls).toEqual([]);
  });

  it("creates the container when there is none, from the URL's port, user, password and database", async () => {
    const calls = stub("missing");
    const log: string[] = [];
    await expect(ensurePostgres(local, { appName: "My App", log: (l) => log.push(l) })).resolves.toEqual({
      how: "created",
      container: "sanoma-my-app-postgres",
    });
    expect(calls).toEqual([
      ["inspect", "-f", "{{.State.Running}}", "sanoma-my-app-postgres"],
      [
        "run",
        "-d",
        "--name",
        "sanoma-my-app-postgres",
        "-e",
        "POSTGRES_USER=postgres",
        "-e",
        "POSTGRES_PASSWORD=dbos",
        "-e",
        "POSTGRES_DB=sanoma_test",
        "-p",
        "65000:5432",
        "postgres:17",
      ],
    ]);
    expect(log).toEqual([
      "creating Postgres container sanoma-my-app-postgres on port 65000 (postgres:17)",
      "Postgres created in Docker: container sanoma-my-app-postgres",
    ]);
  });

  it("reuses a running container, and starts a stopped one", async () => {
    const running = stub("running");
    await expect(ensurePostgres(local, { appName: "x" })).resolves.toEqual({
      how: "reused",
      container: "sanoma-x-postgres",
    });
    expect(running.map((c) => c[0])).toEqual(["inspect"]);

    const stopped = stub("stopped");
    await expect(ensurePostgres(local, { appName: "x" })).resolves.toEqual({
      how: "reused",
      container: "sanoma-x-postgres",
    });
    expect(stopped.map((c) => c[0])).toEqual(["inspect", "start"]);
  });

  it("says when Docker is not installed, on its first call", async () => {
    const calls = stub("no docker");
    await expect(ensurePostgres(local, { appName: "x" })).rejects.toThrow(
      "docker is not installed; start Postgres and set SANOMA_DATABASE_URL",
    );
    expect(calls).toHaveLength(1);
  });

  it("gives up when the container does not answer within a minute", async () => {
    vi.useFakeTimers();
    stub("running", { never: true });
    const gaveUp = ensurePostgres(local, { appName: "x" }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(60_500);
    expect(await gaveUp).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(
          /did not answer at postgresql:\/\/postgres:\*\*\*@127\.0\.0\.1:65000\/sanoma_test within 60000 ms/,
        ),
      }),
    );
  });

  it("masks the password", () => {
    expect(masked("postgresql://a:secret@h:1/d")).toBe("postgresql://a:***@h:1/d");
    expect(masked("postgresql://h/d")).toBe("postgresql://h/d");
  });
});

const dockerAvailable = childProcess.spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;

/** A port nothing listens on. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

describe.skipIf(!dockerAvailable)("ensurePostgres with Docker", () => {
  const appName = `sanoma-test-${process.pid}`;
  const container = `sanoma-${appName}-postgres`;
  afterAll(() => {
    // With its anonymous volume: postgres:17 declares one, which `rm` alone leaves behind.
    childProcess.spawnSync("docker", ["rm", "-f", "-v", container], { stdio: "ignore" });
  });

  it("creates a container on a free port, then reuses it", async () => {
    const url = `postgresql://postgres:dbos@127.0.0.1:${await freePort()}/sanoma_docker_test`;
    await expect(ensurePostgres(url, { appName })).resolves.toEqual({ how: "created", container });
    expect(
      childProcess
        .execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", container], { encoding: "utf8" })
        .trim(),
    ).toBe("true");
    // Running already: it answers at once.
    await expect(ensurePostgres(url, { appName })).resolves.toEqual({ how: "answered" });
    // Stopped: started again, not created.
    childProcess.execFileSync("docker", ["stop", container], { stdio: "ignore" });
    await expect(ensurePostgres(url, { appName })).resolves.toEqual({ how: "reused", container });
  }, 180_000);
});
