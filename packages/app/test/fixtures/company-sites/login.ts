import { defineConnector, type LoginContext, withSetup } from "@sanoma-ai/workflows";

/** What the app gave each login half it made, for the tests to read. */
export const loginContexts: LoginContext[] = [];

/**
 * A visitor login for the tests: whoever sends the `x-fixture-visitor` cookie is that subject.
 * Its one route signs out, clearing the cookie.
 */
export const fixtureLogin = withSetup(defineConnector("fixture-login", {}), {
  login: (context) => {
    loginContexts.push(context);
    return {
      verify: async (request) => {
        const subject = /(?:^|;\s*)x-fixture-visitor=([^;]*)/.exec(request.headers.get("cookie") ?? "")?.[1];
        return subject ? { subject: decodeURIComponent(subject) } : null;
      },
      handle: async (request) =>
        new URL(request.url).pathname === "/auth/fixture-login/sign-out" && request.method === "POST"
          ? new Response(null, { status: 204, headers: { "set-cookie": "x-fixture-visitor=; Max-Age=0; Path=/" } })
          : undefined,
      signOut: "/auth/fixture-login/sign-out",
    };
  },
});
