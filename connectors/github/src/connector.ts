import { tfConnector } from "@sanoma-ai/bridge/connector";
import { type Connector, defineConnector, type OpSpec, vendorInfo } from "@sanoma-ai/workflows";
import { z } from "zod";
import {
  github_branch_protection,
  github_repository,
  github_repository_deploy_key,
  github_team_membership,
  provider,
} from "./resources.gen.ts";

/**
 * `type` with an `owner` field: the organization or user it belongs to, which the provider takes
 * as its configuration, not as an attribute. A data file always declares it; the driver
 * configures the provider for it on each call (`owned`).
 */
const withOwner = <T extends typeof github_repository | typeof github_team_membership>(type: T, what: string) => ({
  ...type,
  schema: type.schema.extend({ owner: z.string().min(1).describe(what) }),
});

/**
 * GitHub, through the `integrations/github` OpenTofu provider: the generated resource types,
 * what their schema does not say (how each is found), and who GitHub is. The connector, the
 * data-file constructors, the driver and the fake all come from this one record.
 */
export const githubTf = tfConnector({
  vendor: "github",
  provider,
  types: {
    // Named `<owner>/<name>`, as GitHub's `full_name`. Bound by its node id, which a rename keeps,
    // as a rule is by its own (its `id`); the driver resolves either to what the provider imports by.
    repository: {
      tf: withOwner(github_repository, "The organization or user the repository belongs to"),
      title: "Repository",
      identity: "owner/name",
      // An empty name names nothing: the type then says its identity is missing.
      find: ({ owner, name }) => (name ? `${owner}/${name}` : ""),
      bindingId: ({ node_id }) => String(node_id),
      // Apply creates, changes and deletes repositories.
      writable: true,
    },
    branch_protection: {
      tf: github_branch_protection,
      title: "Branch protection rule",
      identity: "repository_id:pattern",
      find: ({ repository_id, pattern }) => `${repository_id}:${pattern}`,
    },
    team_membership: {
      tf: withOwner(github_team_membership, "The organization the team is in"),
      title: "Team membership",
      identity: "owner/team_id:username",
      find: ({ owner, team_id, username }) => `${owner}/${team_id}:${username}`,
    },
    // An SSH key that may clone one repository: a host's, read-only. Found only by its binding,
    // `<owner>/<repository>:<key id>`; apply creates and deletes it (GitHub changes none).
    repository_deploy_key: {
      tf: github_repository_deploy_key,
      title: "Deploy key",
      writable: true,
    },
  },
  // A data file names a repository by the declared one, which stands for `<owner>/<name>`: so a
  // rule and a deploy key take their owner from it. GitHub holds a rule's repository by its node
  // id (`R_…`); a deploy key's `repository` is `<owner>/<name>`, the provider's name with its owner.
  references: {
    branch_protection: { repository_id: { type: "github.repository", by: ["name", "node_id"] } },
    repository_deploy_key: { repository: { type: "github.repository" } },
  },
  // The provider answers an import of a rule that is not there `failed_precondition`, saying it
  // "could not find" it (recorded: testdata/replies/…/github_branch_protection/provider-bridge_main).
  missing: (e) =>
    e.code === "not_found" ||
    (e.code === "failed_precondition" && e.diagnostics.some((d) => d.summary.startsWith("could not find "))),
  info: vendorInfo(import.meta.url),
});

/** The account an installation of the App is on. */
export const Account = z.object({ login: z.string(), type: z.enum(["User", "Organization"]) });

/** An account's or a repository's name: GitHub's characters, never `.` or `..` alone (a path's own). */
const part = z.string().regex(/^(?!\.\.?$)[\w.-]+$/, "a GitHub name: letters, digits, `-`, `_` and `.`");

/** `<owner>/<name>`, as GitHub's `full_name`. */
const fullName = z
  .string()
  .regex(/^(?!\.\.?\/)[\w.-]+\/(?!\.\.?$)[\w.-]+$/, "a repository as <owner>/<name>")
  .describe("The repository, as <owner>/<name>");
const installation = z.number().int().positive().describe("The id of the App's installation that acts");

/**
 * The operations through Sanoma's GitHub App, for a workflow to call: each mints an installation
 * token from the App's keys when called, which is never stored or returned.
 */
const appSpecs = {
  installation: {
    get: {
      effect: "read",
      idempotent: true,
      description: "Read an installation of the GitHub App: the account it is on and which repositories it covers",
      input: z.object({ id: z.number().int().positive().describe("The installation's id") }),
      output: z.object({
        id: z.number(),
        account: Account,
        repositorySelection: z.enum(["all", "selected"]),
      }),
      target: ({ id }: { id: number }) => String(id),
    },
  },
  repository: {
    generate: {
      effect: "write",
      // The driver finds what an earlier try of the same step made, so a retry repeats nothing.
      idempotent: true,
      description: "Make a repository from a template repository, through an installation of the GitHub App",
      input: z.object({
        installation,
        template: z.object({ owner: part, repository: part }).describe("The template"),
        owner: part.describe("The account the new repository belongs to"),
        name: part.describe("The new repository's name"),
        private: z.boolean().default(true).describe("Whether it is private (the default)"),
        description: z.string().optional(),
      }),
      output: z.object({
        id: z.number(),
        fullName: z.string(),
        cloneUrl: z.string(),
        sshUrl: z.string(),
        defaultBranch: z.string(),
      }),
      target: ({ owner, name }: { owner: string; name: string }) => `${owner}/${name}`,
    },
    commit: {
      effect: "write",
      // The driver finds what an earlier try of the same step made, so a retry repeats nothing.
      idempotent: true,
      description:
        "Commit files (path to text) on top of a branch, through an installation of the GitHub App; a branch not there yet starts from the default branch",
      input: z.object({
        installation,
        repository: fullName,
        branch: z.string().min(1),
        message: z.string().min(1),
        files: z.record(z.string().min(1), z.string()).describe("Each file's path and its whole text"),
      }),
      output: z.object({ sha: z.string().describe("The new commit's") }),
      target: ({ repository }: { repository: string }) => repository,
    },
    addDeployKey: {
      effect: "write",
      // The driver finds what an earlier try of the same step made, so a retry repeats nothing.
      idempotent: true,
      description: "Add an SSH deploy key to a repository, through an installation of the GitHub App",
      input: z.object({
        installation,
        repository: fullName,
        title: z.string().min(1),
        key: z.string().min(1).describe("The public key, as `<type> <base64>`"),
        readOnly: z.boolean().default(true).describe("Whether it may only fetch (the default)"),
      }),
      output: z.object({ id: z.number() }),
      target: ({ repository }: { repository: string }) => repository,
    },
  },
} satisfies Record<string, Record<string, OpSpec>>;

/** The operations through the App alone: what the driver's and the fake's App halves implement. */
export const githubApp = defineConnector("github", appSpecs);

const types = githubTf.connector;

/** The connector's specs: the resource types, the repository's group with the operations through the App, and the installation's. */
type GithubSpecs = Omit<typeof githubTf.resources, "repository"> & {
  repository: (typeof githubTf.resources)["repository"]["ops"] & typeof appSpecs.repository;
  installation: typeof appSpecs.installation;
};

/**
 * The connector's operations: each resource type's (`github.repository.read`, …), and those
 * through the App, `installation.get` and, in the repository's group, `generate`, `commit` and
 * `addDeployKey` (Neon's pattern for operations beside a type's).
 */
export const githubOps = {
  ...githubApp,
  // `types` last: its vendor (who GitHub is, and its resource types) is the connector's.
  ...types,
  repository: { ...types.repository, ...githubApp.repository },
} as unknown as Connector<"github", GithubSpecs>;
