import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type App, startApp } from "@sanoma-ai/app";
import { buildApp } from "@sanoma-ai/app/build";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { defineConfig, SanomaClient, startWorker, type Worker } from "@sanoma-ai/workflows";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import fixture from "./fixtures/company/sanoma.config.ts";

// The fixture company served by the app, its public site `account` behind this login, end to
// end: Postgres (`pnpm db:up`) and the built workflows package, as the app's sites-build test.
const fixtureDir = fileURLToPath(new URL("./fixtures/company/", import.meta.url));
const config = defineConfig({ ...fixture, databaseUrl: testDatabaseUrl("better_auth_site") });

/**
 * A request to the app with `host` as its Host, which fetch does not let a caller set, and so with
 * no need for `*.localhost` to resolve (as the app's sites-build test's `rawGet`).
 */
function rawRequest(
  url: string,
  host: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const { hostname, port, pathname, search } = new URL(url);
  return new Promise((done, fail) => {
    httpRequest(
      { host: hostname, port, path: pathname + search, method: init.method, headers: { ...init.headers, host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    )
      .on("error", fail)
      .end(init.body);
  });
}

/** The id of the server function `name` in a build, from its server entry's table of them. */
function serverFnId(distDir: string, name: string): string {
  const server = readFileSync(join(distDir, "server", "server.js"), "utf8");
  const id = new RegExp(`"([0-9a-f]{64})": \\{\\s*functionName: "${name}_createServerFn_handler"`).exec(server)?.[1];
  if (!id) throw new Error(`no server function ${name} in ${distDir}`);
  return id;
}

/** What a browser says of a server function's request from its own page, which Start's CSRF check asks for. */
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

let repo: string;
let worker: Worker;
let app: App;
let distDir: string;

beforeAll(async () => {
  // A company's install has no NODE_PATH, which pnpm's vitest shim sets: Tailwind would find `tailwindcss` there.
  vi.stubEnv("NODE_PATH", undefined);
  // A copy of the fixture whose node_modules holds `sanoma` alone, as a company's install does.
  repo = mkdtempSync(join(tmpdir(), "sanoma-better-auth-"));
  cpSync(fixtureDir, repo, { recursive: true });
  mkdirSync(join(repo, "node_modules"));
  symlinkSync(
    fileURLToPath(new URL("../../../packages/sanoma", import.meta.url)),
    join(repo, "node_modules", "sanoma"),
  );
  [{ distDir }, worker] = await Promise.all([buildApp(repo), startWorker(config)]);
  app = await startApp(config, { port: 0, distDir });
});

afterAll(async () => {
  await app?.close();
  await worker?.stop();
  vi.unstubAllEnvs();
  if (repo) rmSync(repo, { recursive: true, force: true });
});

it("signs a visitor up on the site's host, runs a page as them, never on the app's host, signs them out and in again", async () => {
  const { host: appHost, port } = new URL(app.url);
  const site = `account.localhost:${port}`;
  const at = (path: string, host: string, init?: Parameters<typeof rawRequest>[2]) =>
    rawRequest(new URL(path, app.url).href, host, init);
  const getActor = `/_serverFn/${serverFnId(distDir, "getActor")}`;
  /** What `getActor` answers on `host` with `cookie`: always an answer, someone or nobody. */
  const whoIs = async (host: string, cookie: string) => {
    const { status, body } = await at(getActor, host, { headers: { ...SAME_ORIGIN, cookie } });
    expect(status, body).toBe(200);
    return body;
  };

  /** A form's JSON POST to the login's `route`, from a page on `host`. */
  const post = (route: string, host: string, body: object) =>
    at(`/auth/better-auth/${route}`, host, {
      method: "POST",
      headers: { origin: `http://${host}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  /** The session cookie an answer sets, as `name=value`. */
  const cookieOf = (answer: Awaited<ReturnType<typeof at>>) => {
    const [setCookie] = (answer.headers["set-cookie"] as string[] | undefined) ?? [];
    expect(setCookie, answer.body).toMatch(/^better-auth\.session_token=.*; HttpOnly/i);
    return setCookie!.split(";")[0]!;
  };

  const credentials = { email: `${randomUUID()}@example.com`, password: randomBytes(12).toString("base64") };
  const signUp = await post("sign-up/email", site, { ...credentials, name: "Ada" });
  expect(signUp.status, signUp.body).toBe(200);
  const { user } = JSON.parse(signUp.body) as { user: { id: string } };
  const cookie = cookieOf(signUp);
  const visitor = `visitor:better-auth:${user.id}`;

  // Who the page says is on it, in the built-in group, with the login's sign-out.
  const actor = await whoIs(site, cookie);
  expect(actor).toContain(`"${visitor}"`);
  expect(actor).toContain('"visitors"');
  expect(actor).toContain('"/auth/better-auth/sign-out"');

  // A page's loader starts hello as the visitor, which policies/visitors.cedar permits, and no one else.
  const started = async (headers: Record<string, string> = {}) =>
    (await at("/started", site, { headers })).body.replaceAll("<!-- -->", "").match(/<p>([^<]+)<\/p>/)?.[1];
  const said = await started({ cookie });
  const runId = said?.match(/^Started (.+)$/)?.[1];
  expect(runId, said).toBeDefined();
  expect(await started()).toBe("Refused: policy_denied");
  const client = await SanomaClient.connect(config);
  try {
    expect((await client.run(runId!))?.startedBy).toMatchObject({ id: visitor });
  } finally {
    await client.close();
  }

  // On the app's own host the cookie is nobody's, and the login has no routes.
  expect(await whoIs(appHost, cookie)).not.toContain(user.id);
  const elsewhere = await post("sign-up/email", appHost, {
    ...credentials,
    email: `${randomUUID()}@example.com`,
    name: "Bo",
  });
  expect([elsewhere.status, elsewhere.headers["set-cookie"]]).toEqual([404, undefined]);

  // The app's Sign out: a POST with no body, from the site's page; the session is gone after it.
  const signOut = await at("/auth/better-auth/sign-out", site, {
    method: "POST",
    headers: { origin: `http://${site}`, cookie },
  });
  expect(signOut.status, signOut.body).toBe(200);
  expect(await whoIs(site, cookie)).not.toContain(user.id);

  // The sign-in form brings the same visitor back.
  const signIn = await post("sign-in/email", site, credentials);
  expect(signIn.status, signIn.body).toBe(200);
  expect(await whoIs(site, cookieOf(signIn))).toContain(`"${visitor}"`);
});
