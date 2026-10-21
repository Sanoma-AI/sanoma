// Who may use this company's app, the agents that act in it, and the groups: resources like any
// other, read without running. Only a declared person signs in (the loopback sign-in by id,
// GitHub sign-in by email, then login), and acts in the groups that list them; an agent is in
// the group `agents` besides. Policies and approvals name people by id and groups by name.
import { sanoma } from "sanoma/resources";

/** Who started the company: `sanoma init` wrote them here. */
export const founder = sanoma.person({ id: "founder" });

/** Who reviews a post before it is published (policies/policy.ts). */
export const editor = sanoma.person({ id: "editor", name: "Editor" });

export const admin = sanoma.group({ name: "admin", members: [founder] });
