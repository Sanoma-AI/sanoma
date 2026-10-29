import { githubTf } from "./connector.ts";

/**
 * The constructors a data file declares GitHub resources with:
 * `export const site = github.repository({ owner: "acme", name: "website", has_wiki: false })`.
 */
export const github = githubTf.resources;
