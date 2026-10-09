import { github } from "@sanoma/connector-github/resources";

export const web = { name: "web" };
export const site = github.repository({ name: "site" });
