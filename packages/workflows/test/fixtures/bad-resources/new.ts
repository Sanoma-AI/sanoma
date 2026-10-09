import { github } from "@sanoma/connector-github/resources";

export const web = github.repository({ name: "web", topics: new Array<string>() });
