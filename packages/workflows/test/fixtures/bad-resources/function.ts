import { github } from "@sanoma/connector-github/resources";

export function name() {
  return "web";
}

export const web = github.repository({ name: "web" });
