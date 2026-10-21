import { describe, expect, it } from "vitest";
import { isLoopback } from "@sanoma-ai/workflows/shared";
import { ACTOR_COOKIE, ACTOR_HEADER } from "../src/api.ts";
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
