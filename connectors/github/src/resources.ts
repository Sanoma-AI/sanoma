import { githubTf } from "./connector.ts";

/**
 * The constructors a data file declares GitHub resources with:
 * `export const site = github.repository({ name: "website", has_wiki: false })`.
 */
export const github = githubTf.resources;
