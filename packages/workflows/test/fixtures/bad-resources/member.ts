import { github } from "@sanoma/connector-github/resources";

export const web = github.repository({ name: "web" });
export const webMain = github.branch_protection({ repository_id: web.name, pattern: "main" });
