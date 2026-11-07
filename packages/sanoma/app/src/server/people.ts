// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { ADMIN, type Principal } from "sanoma/workflows";
import { personsOf } from "sanoma/workflows/shared";
import { ApiError, type InviteLink, type PeopleSignIns } from "../api.ts";
import type { AppContext } from "../context.ts";

// People's sign-in facts: when each declared person last signed in (the ledger's
// `signin.recorded`), and an invite link for one, minted by the app's staff login.

/** The declared people, by id, with their email when declared. */
const declared = ({ snapshot }: Pick<AppContext, "snapshot">) => personsOf(snapshot.people.people);

/** The email the people files declare for `id`, if any: what a sign-in code goes to and an invite is for. */
export const declaredEmail = (app: Pick<AppContext, "snapshot">, id: string): string | undefined =>
  declared(app).find((p) => p.id === id)?.email;

/** When each declared person last signed in and how, and whether this app mints invites (a host's staff login does). */
export async function peopleSignIns(app: AppContext): Promise<PeopleSignIns> {
  const last = await app.client.lastSignIns(declared(app).map((p) => p.id));
  return { invites: app.login.invite !== undefined, last };
}

/**
 * A one-use invite link for the declared person `person`, by `actor`, on `origin`: it signs them
 * in once, for 24 hours, and replaces their last. Refused for someone with no email declared, and
 * on this machine, where the person picker signs anyone in.
 */
export async function invitePerson(
  app: AppContext,
  actor: Principal,
  person: string,
  origin: string,
): Promise<InviteLink> {
  if (!app.login.invite) {
    throw new ApiError(409, {
      error: "Invite links are for the app on a host: here, the person picker signs anyone in",
    });
  }
  // An invite signs its holder in as that person: only an admin hands one out.
  if (!actor.groups?.includes(ADMIN)) {
    throw new ApiError(403, { error: `Only someone in ${ADMIN} makes an invite link`, code: "not_approver" });
  }
  const found = declared(app).find((p) => p.id === person);
  if (!found) throw new ApiError(404, { error: `No person ${person} is declared` });
  if (!found.email) {
    throw new ApiError(409, { error: `${person} has no email declared: add one to sign them in by invite` });
  }
  const { url, expiresAt } = await app.login.invite(found.email, { origin, by: actor.id });
  return { url, expiresAt: expiresAt.toISOString() };
}
