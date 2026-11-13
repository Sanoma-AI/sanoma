import { tfConnector } from "sanoma/internal/bridge/connector";
import { type Connector, defineConnector, type OpSpec, vendorInfo } from "sanoma/workflows";
import { z } from "zod";
import { MintedToken } from "./rest.ts";
import {
  github_branch_protection,
  github_repository,
  github_repository_collaborator,
  github_repository_deploy_key,
  github_team_membership,
  provider,
} from "./resources.gen.ts";

/**
 * A collaborator whose `permission` a data file always states: the provider's default (`push`)
 * would otherwise demote an `admin`, as a new permission is a replace.
 */
const collaborator = {
  ...github_repository_collaborator,
  schema: github_repository_collaborator.schema.extend({ permission: z.string().min(1) }),
};

/**
 * `type` with an `owner` field: the organization or user it belongs to, which the provider takes
 * as its configuration, not as an attribute. A data file always declares it; the driver
 * configures the provider for it on each call (`owned`).
 */
const withOwner = <T extends typeof github_repository | typeof github_team_membership>(type: T, what: string) => ({
  ...type,
  schema: type.schema.extend({ owner: z.string().min(1).describe(what) }),
});

/** A public key as GitHub keeps it: its type and its key, without a comment (`ssh-rsa AAAA…`). */
export const keyText = (key: string) => key.trim().split(/\s+/).slice(0, 2).join(" ");

/**
 * A deploy key's identity, `<owner>/<repository>:<key text>`, before it is bound: told from its
 * binding, `<owner>/<repository>:<key id>`, by what follows the colon, never only digits.
 */
export const isKeyIdentity = (id: string) => !/:\d+$/.test(id);

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
    // An SSH key that may clone one repository: a host's, read-only. Bound by `<owner>/<repository>:<key id>`,
    // and found before it is by its repository and key text (GitHub takes a key once), so a key
    // GitHub holds already is bound, not made again; apply creates and deletes it (GitHub changes none).
    repository_deploy_key: {
      tf: github_repository_deploy_key,
      title: "Deploy key",
      identity: "repository:key",
      find: ({ repository, key }) => (repository && key ? `${repository}:${keyText(key)}` : ""),
      writable: true,
    },
    // Who may push to one repository (or pull, triage, ...): apply invites them (see the README).
    repository_collaborator: {
      tf: collaborator,
      title: "Collaborator",
      identity: "repository:username",
      // The repository as `<owner>/<name>`; the driver gives the provider `<name>:<username>`.
      find: ({ repository, username }) => `${repository}:${username}`,
      writable: true,
    },
  },
  // A data file names a repository by the declared one, which stands for `<owner>/<name>`: so a
  // rule, a deploy key and a collaborator take their owner from it. GitHub holds a rule's
  // repository by its node id (`R_…`); a deploy key's and a collaborator's `repository` is
  // `<owner>/<name>`, the provider's name with its owner.
  references: {
    branch_protection: { repository_id: { type: "github.repository", by: ["name", "node_id"] } },
    repository_deploy_key: { repository: { type: "github.repository" } },
    repository_collaborator: { repository: { type: "github.repository" } },
  },
  // The provider answers an import of a rule that is not there `failed_precondition`, saying it
  // "could not find" it (recorded: testdata/replies/…/github_branch_protection/provider-bridge_main).
  missing: (e) =>
    e.code === "not_found" ||
    (e.code === "failed_precondition" && e.diagnostics.some((d) => d.summary.startsWith("could not find "))),
  info: vendorInfo(import.meta.url),
});

/** The account an installation of the App is on: its login, and its id, which a rename keeps. */
export const Account = z.object({ login: z.string(), id: z.number(), type: z.enum(["User", "Organization"]) });

/** An account's or a repository's name: GitHub's characters, never `.` or `..` alone (a path's own). */
const part = z.string().regex(/^(?!\.\.?$)[\w.-]+$/, "a GitHub name: letters, digits, `-`, `_` and `.`");

/** `<owner>/<name>`, as GitHub's `full_name`. */
const fullName = z
  .string()
  .regex(/^(?!\.\.?\/)[\w.-]+\/(?!\.\.?$)[\w.-]+$/, "a repository as <owner>/<name>")
  .describe("The repository, as <owner>/<name>");
const installation = z.number().int().positive().describe("The id of the App's installation that acts");
/** A path inside the repository (or a ref), `/`-separated: no part empty, `.` or `..`, so its URL stays the repository's. */
const inside = z
  .string()
  .refine(
    (path) => path.split("/").every((step) => step && step !== "." && step !== ".."),
    "a path inside the repository",
  );

/**
 * The operations through Sanoma's GitHub App, for a workflow to call: each mints an installation
 * token from the App's keys when called, never stored; only `repository.token` returns the one it
 * mints, and the ledger records it by name alone.
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
    files: {
      effect: "read",
      idempotent: true,
      description:
        "Read files (path to text) of a repository at a ref, through an installation of the GitHub App; a file not there is left out",
      input: z.object({
        installation,
        repository: fullName,
        paths: z.array(inside).describe("The files' paths, from the repository's root"),
        ref: inside.optional().describe("A branch, tag or commit; the default branch's head when left out"),
      }),
      output: z.record(z.string(), z.string()).describe("Each file there and its whole text"),
      target: ({ repository }: { repository: string }) => repository,
    },
    head: {
      effect: "read",
      idempotent: true,
      description: "Read the commit a branch is at, through an installation of the GitHub App",
      input: z.object({ installation, repository: fullName, branch: z.string().min(1) }),
      output: z.object({ sha: z.string().describe("The branch's head commit") }),
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
    token: {
      effect: "access",
      // Each try mints a token of its own, which changes nothing at GitHub.
      idempotent: true,
      description:
        "Mint an installation token of the GitHub App for one repository alone, with only the permissions named, good for an hour",
      input: z.object({
        installation,
        repository: fullName,
        permissions: z
          .record(z.string().min(1), z.enum(["read", "write"]))
          // GitHub gives a token minted with no permissions named all the installation's.
          .refine((named) => Object.keys(named).length > 0, "name at least one permission")
          .describe('What the token may do, by GitHub\'s permission names: `{ contents: "write" }`'),
      }),
      output: MintedToken,
      target: ({ repository }: { repository: string }) => repository,
      // A bearer for the repository: the ledger records that there was one, not what it was.
      opaque: ["token"],
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
 * through the App, `installation.get` and, in the repository's group, `generate`, `commit`, `files`,
 * `head`, `addDeployKey` and `token` (Neon's pattern for operations beside a type's).
 */
export const githubOps = {
  ...githubApp,
  // `types` last: its vendor (who GitHub is, and its resource types) is the connector's.
  ...types,
  repository: { ...types.repository, ...githubApp.repository },
} as unknown as Connector<"github", GithubSpecs>;
