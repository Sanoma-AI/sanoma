// Who may use this company's app, the agents that act in it, and the groups: resources like any
// other, loaded as any data file is. Only a declared person signs in (the loopback sign-in by id,
// GitHub sign-in by email, then login), and acts in the groups that list them; an agent is in
// the group `agents` besides. Policies (policies/*.cedar) and approvals name people by id and
// groups by name.
import { sanoma } from "sanoma/resources";

/** Who started the company: `sanoma init` wrote them here. */
export const founder = sanoma.person({ id: "founder" });

/**
 * Who reviews a post the scenarios publish: a stand-in, who can sign in and approve like anyone
 * declared. Replace them with a real colleague, here and in the scenarios.
 */
export const reviewer = sanoma.person({ id: "reviewer", name: "Reviewer" });

export const admin = sanoma.group({ name: "admin", members: [founder] });

/** Whoever publishes or sends without a review, and reviews everyone else's (policies/policy.cedar). */
export const editor = sanoma.group({ name: "editor", members: [founder, reviewer] });
