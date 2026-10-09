import { githubTf } from "./connector.ts";

/**
 * GitHub resources, read through the `integrations/github` OpenTofu provider: each type has a
 * `read` and an `import` operation (`github.repository.read`), both effect `read`.
 */
export const github = githubTf.connector;
