import { github } from "@sanoma/connector-github/resources";

const name = "web";

export const web = github.repository({ name });
