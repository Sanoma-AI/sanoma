import { github } from "@sanoma/connector-github/resources";

// oxlint-disable-next-line unicorn/no-useless-spread
export const web = github.repository({ name: "web", ...{ has_wiki: false } });
