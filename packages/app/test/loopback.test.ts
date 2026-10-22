import { describe, expect, it } from "vitest";
import { isLoopback } from "@sanoma-ai/workflows/shared";
import { ACTOR_COOKIE, ACTOR_HEADER } from "../src/api.ts";
import { sanoma } from "@sanoma-ai/workflows/resources";
import { admitting } from "../src/login/admission.ts";
import { actorFromCookie, hostName, loopbackLogin } from "../src/loopback.ts";

// The Host names a loopback-only app answers to, and whom it takes a request to be from. No
// database, no build.
const answers = (host: string) => isLoopback(hostName(host));

describe("the loopback rule", () => {
  it("accepts this machine's names, with or without a port, in any case", () => {
    for (const host of [
      "localhost",
      "localhost:1234",
      "LOCALHOST",
      "127.0.0.1:80",
      "127.5.5.5",
      "[::1]:1234",
      "[::1]",
    ]) {
      expect(answers(host), host).toBe(true);
    }
  });

  it("refuses any other name, including one that starts like a loopback address", () => {
    for (const host of ["127.0.0.1.evil.com", "evil.com:80", "localhost.evil.com", "0.0.0.0", "[::2]:1", ""]) {
      expect(answers(host), host).toBe(false);
    }
  });
});

/** What the loopback login answers a request addressed to `host`: undefined lets it through. */
const handled = (host: string) =>
  loopbackLogin().handle!(new Request("http://127.0.0.1/", { headers: { host } })) as Response | undefined;

describe("the loopback login's hosts", () => {
  it("lets this machine's names through, `*.localhost` too (a public site's host), and refuses any other with a 403", () => {
    for (const host of ["localhost:3000", "127.0.0.1", "www.localhost:3000", "a.b.localhost"]) {
      expect(handled(host), host).toBeUndefined();
    }
    for (const host of ["attacker.example", "localhost.attacker.example", "wwwlocalhost", ""]) {
      expect(handled(host)?.status, host).toBe(403);
    }
  });
});

/** Whom the loopback login takes a request with these headers to be from. */
const who = (headers: Record<string, string>) =>
  loopbackLogin().resolveActor(new Request("http://127.0.0.1/", { headers }));

describe("whom the loopback login takes a request to be from", () => {
  it("is the name in the header, else the one in the page's cookie, as the server renders a page", () => {
    const cookie = `theme=dark; ${ACTOR_COOKIE}=${encodeURIComponent("Ada Lovelace")}`;
    expect(who({ cookie })).toEqual({ id: "Ada Lovelace" });
    expect(who({ cookie, [ACTOR_HEADER]: "grace" })).toEqual({ id: "grace" });
    expect(who({ cookie: `${ACTOR_COOKIE}=%20%20` })).toBeUndefined();
    expect(who({})).toBeUndefined();
  });

  it("reads the cookie's name decoded once: a name with a % in it stays as typed", () => {
    const request = new Request("http://127.0.0.1/", {
      headers: { cookie: `${ACTOR_COOKIE}=${encodeURIComponent("100%41")}` },
    });
    expect(actorFromCookie(request)).toEqual({ id: "100%41" });
  });
});

/** A request from this machine, naming `name` in the header. */
const asked = (name: string, path = "/", method = "GET") =>
  new Request(`http://127.0.0.1${path}`, { method, headers: { host: "127.0.0.1", [ACTOR_HEADER]: name } });

describe("the loopback login, admitting only declared people", () => {
  const ada = sanoma.person({ id: "ada" });
  const people = [ada, sanoma.agent({ id: "bot" }), sanoma.group({ name: "finance", members: [ada] })];
  const login = admitting(loopbackLogin(), () => ({ people, problems: [] }));

  it("takes a declared person's id as the declared principal", async () => {
    expect(await login.resolveActor(asked("ada"))).toEqual({ id: "ada", groups: ["finance"] });
    expect(await login.handle!(asked("ada"))).toBeUndefined();
  });

  it("refuses an agent's id and an undeclared name: a page to forget it, JSON for a server function", async () => {
    for (const name of ["bot", "scenarios", "Ada"]) {
      expect(await login.resolveActor(asked(name))).toBeUndefined();
      const page = (await login.handle!(asked(name)))!;
      expect(page.status).toBe(403);
      expect(await page.text()).toContain("Use another name");
      const fn = (await login.handle!(asked(name, "/_serverFn/abc", "POST")))!;
      expect(await fn.json()).toEqual({
        error: `${name} is not declared in resources/people.ts`,
        code: "not_admitted",
      });
    }
  });

  it("takes any name as given while no person is declared", async () => {
    expect(await admitting(loopbackLogin(), () => ({ people: [], problems: [] })).resolveActor(asked("cy"))).toEqual({
      id: "cy",
    });
  });
});
