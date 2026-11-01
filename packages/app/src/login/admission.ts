import { errorCode, errorMessage, type PeopleResource, type Principal } from "@sanoma-ai/workflows";
import { admit, type DeclaredPeople } from "@sanoma-ai/workflows/describe";
import { ACTOR_COOKIE, ACTOR_KEY } from "../api.ts";
import type { AdmittingLogin, LoginProvider } from "../context.ts";
import { escapeHtml, smallPage, wantsJson } from "./page.ts";

// Admission is declaration: whoever a login says is asking is let in only as a person the data
// files declare (`sanoma.person`), matched by what the login vouches for, and acts as declared
// (`admit`). An agent never signs in. One wrapper for every login, so no provider can forget it.

/**
 * The login, admitting only a declared person: `resolveActor` returns the declared principal,
 * and a request from anyone else is refused with a 403 saying why (JSON, `not_admitted`, for a
 * server function or any change; a page for anything else). `people` reads the data files'
 * people (`readPeople`). While they declare no person, a login that names an id (the loopback's)
 * is taken as it says; one that does not (GitHub's), nobody.
 */
export function admitting(
  login: LoginProvider,
  people: () => Pick<DeclaredPeople, "problems"> & { people: readonly PeopleResource[] },
): AdmittingLogin {
  // Each request's answer, shared by `handle` and the `resolveActor` the server then asks.
  const answers = new WeakMap<Request, Promise<{ admitted?: Principal; why?: string }>>();
  const resolve = (request: Request) => {
    let answer = answers.get(request);
    if (!answer) {
      answer = (async () => {
        const identity = await login.resolveActor(request);
        if (!identity) return {};
        try {
          return { admitted: admit(identity, people(), true) };
        } catch (e) {
          if (errorCode(e) === "not_admitted") return { why: (e as Error).message };
          // Who is asking could not be read: refused, saying why, rather than every request failing.
          return { why: `Who is asking could not be checked: ${errorMessage(e)}` };
        }
      })();
      answers.set(request, answer);
    }
    return answer;
  };
  return {
    ...login,
    async resolveActor(request) {
      return (await resolve(request)).admitted;
    },
    async handle(request) {
      const answer = await login.handle?.(request);
      if (answer) return answer;
      const { why } = await resolve(request);
      return why === undefined ? undefined : refuse(request, why, login);
    },
  };
}

/** The 403 for a login nobody declared: JSON for the page's server functions and any change, else a page. */
function refuse(request: Request, error: string, login: LoginProvider): Response {
  if (wantsJson(request)) {
    return Response.json({ error, code: "not_admitted" }, { status: 403, headers: { "cache-control": "no-store" } });
  }
  // The loopback login takes the name the page keeps: forgetting it lets the page ask again. A
  // login with its own sign-out signs out instead.
  const leave = login.signOut
    ? `fetch(${JSON.stringify(login.signOut)},{method:"POST"}).then(()=>location.reload())`
    : `localStorage.removeItem(${JSON.stringify(ACTOR_KEY)});document.cookie=${JSON.stringify(`${ACTOR_COOKIE}=; max-age=0; path=/; samesite=strict`)};location.reload()`;
  return smallPage(
    403,
    "Not admitted",
    `<p>${escapeHtml(error)}. Ask someone to add you there, or to fix the file.</p>` +
      `<p><button type="button" onclick='${escapeHtml(leave)}'>${login.signOut ? "Sign out" : "Use another name"}</button></p>`,
  );
}
