import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { testDatabaseUrl } from "@sanoma/testing";
import { afterAll, describe, expect, it } from "vitest";
import { ensurePostgres, masked } from "../src/postgres.ts";

// `answered` needs Postgres (`pnpm db:up`); the Docker cases run a stub, and the last describe
// real Docker when it is installed.

/**
 * A docker stub: answers `inspect` as `state` says and records every call. The probe answers
 * once Postgres would: after `run` or `start`, or, for a container already running (still
 * starting up, since the probe did not answer before), after `inspect`.
 */
function stub(state: "running" | "stopped" | "missing") {
  const calls: string[][] = [];
  let up = false;
  const docker = async (args: string[]) => {
    calls.push(args);
    switch (args[0]) {
      case "inspect":
        if (state === "missing") throw new Error("Error: No such object");
        if (state === "running") up = true;
        return `${state === "running"}\n`;
      case "start":
      case "run":
        up = true;
        return "abc123\n";
      default:
        throw new Error(`unexpected docker ${args.join(" ")}`);
    }
  };
  return { calls, docker, probe: async () => up };
}

const local = "postgresql://postgres:dbos@127.0.0.1:65000/sanoma_test";

/** What `execFile("docker")` rejects with when there is no docker. */
const notInstalled = async (): Promise<string> => {
  throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
};

describe("ensurePostgres", () => {
  it("answers when Postgres is there", async () => {
    await expect(ensurePostgres(testDatabaseUrl("sanoma-pg"), { appName: "x" })).resolves.toEqual({ how: "answered" });
  });

  it("throws for a silent host that is not this machine, naming the URL without its password", async () => {
    await expect(
      ensurePostgres("postgresql://u:p@10.255.255.1:5432/x", { appName: "x", probeTimeoutMs: 500 }),
    ).rejects.toThrow(
      "nothing answers at postgresql://u:***@10.255.255.1:5432/x; start Postgres or set SANOMA_DATABASE_URL",
    );
  });

  it("creates the container when there is none, from the URL's port, user, password and database", async () => {
    const { calls, docker, probe } = stub("missing");
    const log: string[] = [];
    await expect(ensurePostgres(local, { appName: "My App", docker, probe, log: (l) => log.push(l) })).resolves.toEqual(
      {
        how: "created",
        container: "sanoma-my-app-postgres",
      },
    );
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
    expect(log).toEqual(["creating Postgres container sanoma-my-app-postgres on port 65000 (postgres:17)"]);
  });

  it("reuses a running container, and starts a stopped one", async () => {
    const running = stub("running");
    await expect(ensurePostgres(local, { appName: "x", ...running })).resolves.toEqual({
      how: "reused",
      container: "sanoma-x-postgres",
    });
    expect(running.calls.map((c) => c[0])).toEqual(["inspect"]);

    const stopped = stub("stopped");
    await expect(ensurePostgres(local, { appName: "x", ...stopped })).resolves.toEqual({
      how: "reused",
      container: "sanoma-x-postgres",
    });
    expect(stopped.calls.map((c) => c[0])).toEqual(["inspect", "start"]);
  });

  it("says when Docker is not installed", async () => {
    await expect(
      ensurePostgres(local, { appName: "x", docker: notInstalled, probe: async () => false }),
    ).rejects.toThrow("docker is not installed; start Postgres and set SANOMA_DATABASE_URL");
  });

  it("gives up when the container never answers", async () => {
    const { docker } = stub("running");
    await expect(ensurePostgres(local, { appName: "x", docker, probe: async () => false, waitMs: 0 })).rejects.toThrow(
      /did not answer at postgresql:\/\/postgres:\*\*\*@127\.0\.0\.1:65000\/sanoma_test within 0 ms/,
    );
  });

  it("masks the password", () => {
    expect(masked("postgresql://a:secret@h:1/d")).toBe("postgresql://a:***@h:1/d");
    expect(masked("postgresql://h/d")).toBe("postgresql://h/d");
  });
});

const dockerAvailable = spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;

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
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  });

  it("creates a container on a free port, then reuses it", async () => {
    const url = `postgresql://postgres:dbos@127.0.0.1:${await freePort()}/sanoma_docker_test`;
    const log: string[] = [];
    const created = await ensurePostgres(url, { appName, log: (l) => log.push(l) });
    expect(created).toEqual({ how: "created", container });
    expect(
      execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", container], { encoding: "utf8" }).trim(),
    ).toBe("true");
    // Running already: it answers at once.
    await expect(ensurePostgres(url, { appName })).resolves.toEqual({ how: "answered" });
    // Stopped: started again, not created.
    execFileSync("docker", ["stop", container], { stdio: "ignore" });
    await expect(ensurePostgres(url, { appName })).resolves.toEqual({ how: "reused", container });
  }, 180_000);
});
