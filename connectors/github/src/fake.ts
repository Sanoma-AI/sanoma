import { createHash } from "node:crypto";
import { type FixtureError, tfFake, type TfFakeOptions, type TfFakeState } from "@sanoma-ai/bridge/fake";
import { DriverError } from "@sanoma-ai/workflows";
import type { z } from "zod";
import { defineFake, type FakeOptions } from "@sanoma-ai/workflows/fake";
import { githubApp, githubTf } from "./connector.ts";
import { branchPath, failed } from "./rest.ts";
import { owned } from "./owner.ts";

/**
 * What the provider answers an import of an object that is not there: for a branch protection
 * rule, `failed_precondition` with the diagnostic it was recorded with (`provider-bridge:main`);
 * for anything else, nothing found (`not_found`).
 */
function missingReply(type: string, id: string): FixtureError | undefined {
  if (type !== "branch_protection") return undefined;
  const summary = `could not find a branch protection rule with the pattern '${id.slice(id.indexOf(":") + 1)}'`;
  return {
    code: "failed_precondition",
    message: `import github_branch_protection "${id}": ${summary}`,
    diagnostics: [{ severity: "SEVERITY_ERROR", summary }],
  };
}

export type FakeGithubState = TfFakeState;
export type FakeGithubOptions = TfFakeOptions;

/** A repository as the App's fake keeps one: its branches' heads and files, and its deploy keys. */
export interface FakeAppRepository {
  id: number;
  private: boolean;
  description?: string;
  defaultBranch: string;
  branches: Record<string, { sha: string; files: Record<string, string> }>;
  keys: { id: number; title: string; key: string; readOnly: boolean }[];
}

export interface FakeGithubAppState extends Record<string, unknown> {
  /** Counts up, for ids made in order. */
  seq: number;
  /** The App's installations, by id. */
  installations: Record<number, Omit<z.output<typeof githubApp.installation.get.output>, "id">>;
  /** The repositories, by `<owner>/<name>`. */
  repositories: Record<string, FakeAppRepository>;
}

/** A SHA of `parts`, as a commit's: the same for the same parts. */
const shaOf = (...parts: unknown[]) => createHash("sha1").update(JSON.stringify(parts)).digest("hex");

/** The `DriverError` the driver makes of GitHub's answer `status` to `<method> <path>`. */
const fail = (where: string, status: number, message: string, errors: string[] = []) => {
  const [method = "", path = ""] = where.split(" ");
  const body = { message, ...(errors.length && { errors: errors.map((e) => ({ message: e })) }) };
  return failed(method, path, { status, headers: new Headers(), body });
};

/** The fake's template, which `repository.generate` copies. */
export const FAKE_TEMPLATE = "Sanoma-AI/company-template";

/**
 * The operations through the App, over an in-memory GitHub: installation 7 on the personal account
 * `acme`, 9 on the organization `acme-inc`, and the public template `Sanoma-AI/company-template` (`main`, a README). An installation
 * reaches the repositories of its own account; a commit's SHA is the same for the same parent,
 * message and files.
 */
export function fakeGithubApp(options: FakeOptions = {}) {
  return defineFake(
    githubApp,
    {
      initial: (): FakeGithubAppState => ({
        seq: 1,
        installations: {
          7: { account: { login: "acme", id: 7, type: "User" }, repositorySelection: "all" },
          9: { account: { login: "acme-inc", id: 9, type: "Organization" }, repositorySelection: "all" },
        },
        repositories: {
          [FAKE_TEMPLATE]: {
            id: 1,
            private: false,
            defaultBranch: "main",
            branches: { main: { sha: shaOf("template"), files: { "README.md": "# Company\n" } } },
            keys: [],
          },
        },
      }),
      ops: (state) => {
        /** The installation, as its JWT reads it (`where`), else its token is minted. */
        const installed = (id: number, where = `POST /app/installations/${id}/access_tokens`) => {
          const found = state.installations[id];
          if (!found) throw fail(where, 404, "Not Found");
          return found;
        };
        /** Whether `owner` is the installation's account. */
        const owns = (installation: number, owner: string) =>
          owner.toLowerCase() === installed(installation).account.login.toLowerCase();
        /** A repository the installation reaches (one of its own account's), as `<method> <path under it>` asks. */
        const reached = (installation: number, repository: string, where: string) => {
          const found = state.repositories[repository];
          if (!found || !owns(installation, repository.split("/")[0]!)) {
            const [method, path] = where.split(" ");
            throw fail(`${method} /repos/${repository}${path}`, 404, "Not Found");
          }
          return found;
        };
        return {
          installation: {
            get: async ({ id }) => ({ id, ...installed(id, `GET /app/installations/${id}`) }),
          },
          repository: {
            generate: async ({ installation, template, owner, name, private: isPrivate, description }) => {
              const mine = owns(installation, owner);
              const where = `POST /repos/${template.owner}/${template.repository}/generate`;
              const from = state.repositories[`${template.owner}/${template.repository}`];
              if (!from) throw fail(where, 404, "Not Found");
              if (!mine) throw fail(where, 403, "Resource not accessible by integration");
              const fullName = `${owner}/${name}`;
              if (state.repositories[fullName]) {
                throw fail(where, 422, "Validation Failed", ["name already exists on this account"]);
              }
              const files = structuredClone(from.branches[from.defaultBranch]?.files ?? {});
              const id = ++state.seq;
              state.repositories[fullName] = {
                id,
                private: isPrivate,
                ...(description !== undefined && { description }),
                defaultBranch: from.defaultBranch,
                branches: { [from.defaultBranch]: { sha: shaOf(fullName, files), files } },
                keys: [],
              };
              return {
                id,
                fullName,
                cloneUrl: `https://github.com/${fullName}.git`,
                sshUrl: `git@github.com:${fullName}.git`,
                defaultBranch: from.defaultBranch,
              };
            },
            commit: async ({ installation, repository, branch, message, files }) => {
              const repo = reached(installation, repository, `GET /branches/${branchPath(branch)}`);
              const head = repo.branches[branch] ?? repo.branches[repo.defaultBranch];
              if (!head)
                throw new DriverError(`github: ${repository} has no ${repo.defaultBranch}`, {
                  retryable: false,
                  vendorCode: "no_branch",
                });
              const sha = shaOf(head.sha, message, files);
              repo.branches[branch] = { sha, files: { ...head.files, ...files } };
              return { sha };
            },
            head: async ({ installation, repository, branch }) => {
              const repo = reached(installation, repository, `GET /branches/${branchPath(branch)}`);
              const head = repo.branches[branch];
              if (!head) throw fail(`GET /repos/${repository}/branches/${branchPath(branch)}`, 404, "Branch not found");
              return { sha: head.sha };
            },
            addDeployKey: async ({ installation, repository, title, key, readOnly }) => {
              const repo = reached(installation, repository, "POST /keys");
              // GitHub takes a key once across all of GitHub, not once per repository.
              if (Object.values(state.repositories).some((r) => r.keys.some((k) => k.key === key))) {
                throw fail(`POST /repos/${repository}/keys`, 422, "Validation Failed", ["key is already in use"]);
              }
              const id = ++state.seq;
              repo.keys.push({ id, title, key, readOnly });
              return { id };
            },
          },
        };
      },
    },
    options,
  );
}

/**
 * A GitHub that answers as the provider did when its replies were recorded (`@sanoma-ai/bridge`'s
 * `testdata/replies`), through the real driver over a bridge of those replies: `import` and
 * `read` return the recorded repositories (`Sanoma-AI/sanoma`, `Sanoma-AI/provider-bridge`), and
 * `branch_protection` on `provider-bridge:main` fails as it did (the branch is unprotected).
 * Nothing reaches GitHub, and no token is read. Its calls name owners as the driver's do
 * (`Sanoma-AI/sanoma`); a node id is found among its objects, with no query.
 *
 * `put` makes an object, `override` changes what the next read returns, as if someone edited
 * the object at GitHub, and `remove` deletes it, so the next read says it is gone and an import
 * answers as the provider does.
 *
 * The operations through the App answer from `app` (`fakeGithubApp`), with its own state,
 * logging into the same `calls`; the faults (`failNext` and the others) reach either by its id.
 */
export function fakeGithub(options: FakeGithubOptions = {}) {
  const fake = tfFake(githubTf, { missingReply, ...options });
  const app = fakeGithubApp({ calls: fake.calls });
  // Named by owner as the driver's calls are; the fake's own objects are held by the provider's
  // import ids (`sanoma`, `sanoma:main`), what `put`, `override` and `remove` take.
  const { driver, reset, failNext, loseReply, rateLimit, hold } = fake;
  /** Whether `opId` is one of the operations through the App, whose faults are `app`'s. */
  const ofApp = (opId: string) => Object.hasOwn(app.driver.ops, opId.slice("github.".length));
  return Object.assign(fake, {
    driver: { vendor: driver.vendor, ops: { ...owned(() => driver).ops, ...app.driver.ops } },
    app,
    reset() {
      reset();
      app.reset();
    },
    failNext: (opId: string, err?: unknown) =>
      ofApp(opId) ? app.failNext(opId as never, err) : failNext(opId as never, err),
    loseReply: (opId: string) => (ofApp(opId) ? app.loseReply(opId as never) : loseReply(opId as never)),
    rateLimit: (opId: string) => (ofApp(opId) ? app.rateLimit(opId as never) : rateLimit(opId as never)),
    hold: (opId: string) => (ofApp(opId) ? app.hold(opId as never) : hold(opId as never)),
  });
}
