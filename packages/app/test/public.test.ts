import type { LoginHalf } from "@sanoma-ai/workflows";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api.ts";
import { publicFront } from "../src/login/public.ts";
import { PUBLIC_FNS, publicOnly } from "../src/middleware.ts";

// A public site's front door on its own host, and the server functions that host answers.

const request = (path: string, init: RequestInit = {}) => new Request(`http://members.localhost${path}`, init);

/** A login half that takes the `subject` cookie's value as who signed in, and answers its routes with 204. */
const half: LoginHalf = {
  verify: async (req) => {
    const subject = /subject=([^;]*)/.exec(req.headers.get("cookie") ?? "")?.[1];
    return subject === undefined ? null : { subject: decodeURIComponent(subject) };
  },
  handle: async (req) =>
    new URL(req.url).pathname === "/auth/acme/sign-out" ? new Response(null, { status: 204 }) : undefined,
  signOut: "/auth/acme/sign-out",
};

describe("publicFront", () => {
  it("is anonymous on a site with no login, whatever the staff login's cookie or header says", async () => {
    const front = publicFront({ name: "hello" });
    expect(front.name).toBe("site:hello");
    expect(() => front.check("0.0.0.0")).not.toThrow();
    const asked = request("/", { headers: { cookie: "sanoma_actor=ada; sanoma_session=x", "x-sanoma-actor": "ada" } });
    expect(await front.resolveActor(asked)).toEqual({ id: "anonymous", groups: [] });
    expect(front.signOut).toBeUndefined();
  });

  it("is the visitor its login half verifies, in visitors, else anonymous; a subject with a space is nobody's", async () => {
    const front = publicFront({ name: "members", login: "acme" }, Promise.resolve(half));
    expect(await front.resolveActor(request("/", { headers: { cookie: "subject=u1" } }))).toEqual({
      id: "visitor:acme:u1",
      groups: ["visitors"],
    });
    expect(await front.resolveActor(request("/"))).toEqual({ id: "anonymous", groups: [] });
    expect(await front.resolveActor(request("/", { headers: { cookie: "subject=a%20b" } }))).toEqual({
      id: "anonymous",
      groups: [],
    });
    expect(front.signOut).toBe("/auth/acme/sign-out");
  });

  it("sends its login's routes to the half, answers any other /auth/ with a 404 and other methods with a 405, and lets the rest through", async () => {
    let made!: (made: LoginHalf) => void;
    const front = publicFront({ name: "members", login: "acme" }, new Promise((done) => (made = done)));
    // A request that comes before the half is made waits for it.
    const early = front.handle!(request("/auth/acme/sign-out", { method: "POST" }));
    made(half);
    expect((await early)?.status).toBe(204);
    expect((await front.handle!(request("/auth/acme/nope")))?.status).toBe(404);
    for (const path of ["/auth/github/start", "/auth/loopback", "/auth", "/auth/acme-two/x"]) {
      expect((await front.handle!(request(path)))?.status, path).toBe(404);
    }
    expect(await front.handle!(request("/"))).toBeUndefined();
    expect(await front.handle!(request("/authors"))).toBeUndefined();
    expect(await front.handle!(request("/_serverFn/abc", { method: "POST" }))).toBeUndefined();
    const put = await front.handle!(request("/", { method: "PUT" }));
    expect([put?.status, put?.headers.get("allow")]).toEqual([405, "GET, HEAD, POST"]);
    // With no login, every /auth/ route is a 404.
    expect(
      (await publicFront({ name: "hello" }).handle!(request("/auth/acme/sign-out", { method: "POST" })))?.status,
    ).toBe(404);
  });
});

describe("the server functions a public site's host answers", () => {
  const server = publicOnly.options.server as unknown as (options: {
    next: () => unknown;
    context: { app: { site?: string } };
    serverFnMeta: { name: string };
  }) => unknown;
  const call = (name: string, site?: string) =>
    server({ next: () => "answered", context: { app: { site } }, serverFnMeta: { name } });

  it("are callFn and getActor alone: any other is a 404 there, and answers on the app's host", () => {
    expect([...PUBLIC_FNS]).toEqual(["callFn", "getActor"]);
    expect(call("callFn", "hello")).toBe("answered");
    expect(call("getActor", "hello")).toBe("answered");
    for (const name of ["getConfig", "startRunFn", "setCredentialFn", "goLiveFn", "getRuns"]) {
      const thrown = (() => {
        try {
          return call(name, "hello");
        } catch (err) {
          return err;
        }
      })();
      expect(thrown, name).toBeInstanceOf(ApiError);
      expect(thrown, name).toMatchObject({ status: 404 });
      expect(call(name)).toBe("answered");
    }
  });
});
