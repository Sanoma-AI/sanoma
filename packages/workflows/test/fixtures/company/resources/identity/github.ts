import { github } from "@sanoma/connector-github/resources";

// The company's public repositories, and the rule that guards the website's main branch.

export const website = github.repository({
  name: "website",
  description: "The company website",
  visibility: "public",
  has_wiki: false,
  topics: ["website", "astro"],
});

export const docs = github.repository({
  name: "docs",
  description: `Product documentation`,
  visibility: "public",
  has_issues: true,
});

export const websiteMain = github.branch_protection({
  repository_id: website,
  pattern: "main",
  enforce_admins: true,
  required_pull_request_reviews: [{ required_approving_review_count: 1, dismiss_stale_reviews: true }],
});

export default [website, docs, websiteMain];
