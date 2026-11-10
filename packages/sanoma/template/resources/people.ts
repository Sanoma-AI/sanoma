// Who may use this company's app, the agents that act in it, and the groups: resources like any
// other, loaded as any data file is. Only a declared person signs in (on this machine by `id`; on
// a host by an email code to their `email` or an invite link), and acts in the groups that list
// them; an agent is in the group `agents` besides. Policies (policies/*.cedar) and approvals name
// people by id and groups by name. Add colleagues here.
import { sanoma } from "sanoma/resources";

/** Who started the company: `sanoma init` wrote them here. */
export const founder = sanoma.person({ id: "founder" });

/** Whoever sends or publishes without a review, and reviews everyone else's (policies/policy.cedar). */
export const admin = sanoma.group({ name: "admin", members: [founder] });
