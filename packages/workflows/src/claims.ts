// Sanoma's claims: what Sanoma says about connectors and apps that their authors cannot say about
// their own (the tier, whether Sanoma reviewed it, what it blocks), and the solutions, each a kind
// of customer with the apps that cover their problems and one demo repository. Data, changed by
// pull request; `sanoma/claims` re-exports it, so a company and its sites import it statically.
// Browser-safe: nothing here imports anything. Everything else about a connector or an app is
// its author's, read from npm or GitHub (`sanoma.apps.list`), never copied here.

/**
 * Whose a connector or an app is: Sanoma's own, its vendor's (checked by Sanoma), or anyone's. With
 * no claim, `official` is read from the name (the `@sanoma-ai/` scope, the `Sanoma-AI` owner).
 */
export const TIERS = ["official", "vendor-verified", "community"] as const;
export type Tier = (typeof TIERS)[number];

/** What Sanoma says of a connector package, by its npm name. */
export interface ConnectorClaim {
  tier: Tier;
  /** Whether Sanoma read its code. */
  reviewed: boolean;
  /** Versions Sanoma blocks. */
  blocked?: string[];
}

/** What Sanoma says of an app's source repository, by `<owner>/<repo>` on GitHub. */
export interface AppClaim {
  tier: Tier;
  /** Whether Sanoma read its code. */
  reviewed: boolean;
  /** Commits Sanoma blocks, by their full id. */
  blocked?: string[];
  /** The solutions it belongs to, by id. */
  solutions: string[];
}

/**
 * A solution: a kind of customer and the apps that cover their problems, with the one public demo
 * repository (a fictional business of that kind, those apps merged under `apps/`) that a visitor
 * meets it in.
 */
export interface SolutionClaim {
  /** The solution's name, as its page heads it. */
  title: string;
  /** The kind of customer it is for, in their words: "property managers". */
  kind: string;
  /** Its apps' source repositories, `<owner>/<repo>`. */
  apps: string[];
  /** Its demo: the company repository, `<owner>/<repo>`, and where it runs once it does. */
  demo: { repo: string; url?: string };
}

/** Sanoma's claims, each keyed as its kind is named: a package, a repository, a solution's id. */
export interface Claims {
  connectors: Readonly<Record<string, ConnectorClaim>>;
  apps: Readonly<Record<string, AppClaim>>;
  solutions: Readonly<Record<string, SolutionClaim>>;
}

/** Sanoma's claims. Empty until the first outside connector, the first app and the first solution exist. */
export const claims: Claims = {
  connectors: {},
  apps: {},
  solutions: {},
};

/** A connector package's tier: its claim's, else official for the `@sanoma-ai/` scope and community otherwise. */
export const connectorTier = (pkg: string, from: Claims = claims): Tier =>
  from.connectors[pkg]?.tier ?? (pkg.startsWith("@sanoma-ai/") ? "official" : "community");

/** The claim on the app whose source is `repo` (`<owner>/<repo>`, as GitHub names it, in any case). */
export const appClaim = (repo: string, from: Claims = claims): AppClaim | undefined =>
  Object.entries(from.apps).find(([key]) => key.toLowerCase() === repo.toLowerCase())?.[1];

/** The GitHub owner whose repositories are Sanoma's own. */
export const SANOMA_ORG = "Sanoma-AI";

/** An app source's tier: its claim's, else official for the `Sanoma-AI` owner's and community otherwise. */
export const appTier = (repo: string, from: Claims = claims): Tier =>
  appClaim(repo, from)?.tier ??
  (repo.toLowerCase().startsWith(`${SANOMA_ORG.toLowerCase()}/`) ? "official" : "community");
