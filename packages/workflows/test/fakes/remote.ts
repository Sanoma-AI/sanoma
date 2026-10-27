import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CheckResult,
  defineConnector,
  draftBranch,
  draftOf,
  DriverError,
  type PullRequest,
  type RemoteEvent,
  type RemoteHalf,
  type Source,
  type SourceHost,
  withSetup,
} from "../../src/index.ts";

// A git host and a company's repository, both in memory, for the change workflow's tests and the
// lanes that build on it (webhooks, the app's review page, the end-to-end test). `fakeRemote` is a
// connector whose remote half is a host holding pull requests, statuses and merges, whose webhook
// is signed JSON (`delivery`), its branches in memory or in a bare git repository; `memorySource`
// is a `Source` with drafts, whose `push` reaches that host and whose `follow` records the call.

/** A made-up commit id, unique per `seed`. */
export const sha = (seed: string) => createHash("sha1").update(seed).digest("hex");

/** The secret the fake host signs its webhooks with, read through the half's `secrets`. */
export const FAKE_WEBHOOK_SECRET = "FAKEGIT_WEBHOOK_SECRET";
/** The header the fake host's webhook carries its signature in. */
const SIGNATURE = "x-fakegit-signature";
const hmac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

/** A delivery of the fake host's webhook carrying `events`, signed with `secret` (none: unsigned). */
export function delivery(events: RemoteEvent[], secret?: string): RequestInit {
  const body = JSON.stringify(events);
  return {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...(secret !== undefined && { [SIGNATURE]: hmac(secret, body) }) },
  };
}

/** A status the host was given, in order. */
export interface FakeStatus {
  sha: string;
  state: "pending" | "success" | "failure";
  description: string;
  targetUrl?: string;
}

/** A pull request as the fake host keeps it: its title and body too. */
export interface FakePullRequest extends PullRequest {
  title: string;
  body: string;
  base: string;
}

/**
 * A fake git host: `connector` carries its remote half (vendor `fakegit`), for a config's
 * `connectors`; it matches `url` alone, as `acme/company`. What the host was asked is kept:
 * `pulls` by number, the `statuses` set, the `merges` made, the `deleted` branches and the
 * `tokens` given out. `branches` is each branch's commit as pushed. `failMerge(code)` makes the
 * next merge fail with that `vendorCode` (`head_moved`, `not_mergeable`); `push`, `close` and
 * `merge` act as someone on the host would, outside Sanoma.
 *
 * Given `origin`, a bare git repository (`url` its clone URL, as `localGitSource` pushes to and
 * follows it), the host's branches are that repository's, read each time the host is asked, and a
 * merge is a real squash: one commit on its `main` with the pull request's tree, titled as asked.
 */
export function fakeRemote({
  url = "https://git.example/acme/company.git",
  origin,
}: { url?: string; origin?: string } = {}) {
  const pulls = new Map<number, FakePullRequest>();
  const branches = new Map<string, string>();
  const statuses: FakeStatus[] = [];
  const merges: { number: number; sha: string; method: string; title?: string }[] = [];
  const deleted: string[] = [];
  const failures: string[] = [];
  let opened = 0;
  let tokens = 0;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: origin, encoding: "utf8" }).trim();
  /** The branches as `origin` holds them now, when the host is a git repository. */
  const sync = () => {
    if (origin === undefined) return;
    branches.clear();
    for (const line of git("for-each-ref", "--format=%(refname:lstrip=2) %(objectname)", "refs/heads/").split("\n")) {
      const [branch, head] = line.split(" ");
      if (branch && head) branches.set(branch, head);
    }
  };

  const view = (pr: FakePullRequest): PullRequest => ({
    number: pr.number,
    url: pr.url,
    branch: pr.branch,
    // The host reads a pull request at its branch's commit, until it is merged or closed.
    head: pr.state === "open" ? (branches.get(pr.branch) ?? pr.head) : pr.head,
    state: pr.state,
    ...(pr.mergeSha !== undefined && { mergeSha: pr.mergeSha }),
  });
  const pull = (number: number) => {
    const pr = pulls.get(number);
    if (!pr) throw new DriverError(`no pull request #${number}`, { retryable: false, status: 404 });
    return pr;
  };
  const mergeNow = (pr: FakePullRequest, title = pr.title) => {
    sync();
    pr.head = branches.get(pr.branch) ?? pr.head;
    let merged = sha(`merge ${pr.number} ${pr.head}`);
    if (origin !== undefined) {
      // A squash: the tree main and the branch make together, as one commit on main.
      const tree = git("merge-tree", "--write-tree", "main", pr.head).split("\n")[0]!;
      merged = git("commit-tree", tree, "-p", "main", "-m", title);
      git("update-ref", "refs/heads/main", merged);
    }
    pr.state = "merged";
    pr.mergeSha = merged;
    branches.set("main", merged);
    return merged;
  };

  const host: SourceHost = {
    async token() {
      return `token-${++tokens}`;
    },
    async pullRequestFor(branch) {
      sync();
      const all = [...pulls.values()].filter((p) => p.branch === branch);
      const pr = all.find((p) => p.state === "open") ?? all.at(-1);
      return pr && view(pr);
    },
    async pullRequest(number) {
      sync();
      return view(pull(number));
    },
    async openPullRequest({ branch, base, title, body }) {
      sync();
      const head = branches.get(branch);
      if (head === undefined) throw new DriverError(`no branch ${branch} on the host`, { retryable: false });
      const open = [...pulls.values()].find((p) => p.branch === branch && p.base === base && p.state === "open");
      if (open) return view(open);
      const number = ++opened;
      const pr: FakePullRequest = {
        number,
        url: `${url.replace(/\.git$/, "")}/pull/${number}`,
        branch,
        head,
        state: "open",
        title,
        body,
        base,
      };
      pulls.set(number, pr);
      return view(pr);
    },
    async mergePullRequest(number, { sha: at, method, title }) {
      sync();
      const pr = pull(number);
      if (pr.state === "merged") return { sha: pr.mergeSha! };
      const failure = failures.shift();
      if (failure !== undefined)
        throw new DriverError(`the host refuses: ${failure}`, { retryable: false, vendorCode: failure });
      if (pr.state !== "open" || view(pr).head !== at) {
        throw new DriverError("the branch moved", { retryable: false, vendorCode: "head_moved", status: 409 });
      }
      merges.push({ number, sha: at, method, ...(title !== undefined && { title }) });
      return { sha: mergeNow(pr, title) };
    },
    async closePullRequest(number) {
      pull(number).state = "closed";
    },
    async deleteBranch(branch) {
      if (origin !== undefined) git("update-ref", "-d", `refs/heads/${branch}`);
      branches.delete(branch);
      deleted.push(branch);
    },
    async setStatus(status) {
      statuses.push({ ...status });
    },
    async enforcement() {
      return { pullRequest: false, check: false, reason: "a fake host enforces nothing" };
    },
  };
  const half: RemoteHalf = {
    matches: (given) => (given === url ? { owner: "acme", name: "company" } : undefined),
    open: () => host,
    // A delivery is the events themselves, as JSON, signed as `delivery` signs it.
    async webhook(request, { secrets }) {
      const secret = (await secrets([FAKE_WEBHOOK_SECRET])).get(FAKE_WEBHOOK_SECRET);
      if (!secret) throw new DriverError("no webhook secret", { retryable: false, vendorCode: "no_webhook_secret" });
      const body = await request.text();
      if (request.headers.get(SIGNATURE) !== hmac(secret, body)) {
        throw new DriverError("bad signature", { retryable: false, status: 401, vendorCode: "bad_signature" });
      }
      return JSON.parse(body) as RemoteEvent[];
    },
  };
  const connector = withSetup(defineConnector("fakegit", {}), { remote: () => half });

  return {
    url,
    connector,
    half,
    host,
    pulls,
    branches,
    statuses,
    merges,
    deleted,
    /** The tokens given out so far. */
    get tokens() {
      return tokens;
    },
    /** The next merge fails with this `vendorCode`. */
    failMerge(code: "head_moved" | "not_mergeable") {
      failures.push(code);
    },
    /** Someone pushes `head` to `branch` on the host. */
    push(branch: string, head: string) {
      branches.set(branch, head);
    },
    /** Someone closes the pull request on the host. */
    close(number: number) {
      pull(number).state = "closed";
    },
    /** Someone merges the pull request on the host: its merge commit. */
    merge(number: number) {
      return mergeNow(pull(number));
    },
    /** The pull request of `branch` (the latest), as the host keeps it. */
    pullOf(branch: string) {
      return [...pulls.values()].filter((p) => p.branch === branch).at(-1);
    },
  };
}

export type FakeRemote = ReturnType<typeof fakeRemote>;

/**
 * A company's repository in memory, at `root` (its live checkout, where nothing is written), its
 * `origin` the fake host's `url` (none when `remote` is not given). Each draft is a directory of
 * its own holding the files `edit` writes, on the branch `draft/<id>`, its head moved by each edit;
 * `diff` names the files edited. `push` puts a branch's head on the host; `check` answers `checks`
 * (ok by default) and counts each; `follow` and `closeDraft` record their calls, and `follow`
 * answers `followed` (the host's branch, by default; a draft's branch moves the draft's head to it).
 */
export function memorySource({ root, remote }: { root: string; remote?: FakeRemote }) {
  const drafts = new Map<string, { root: string; files: Map<string, string>; head: string; edits: number }>();
  const checks = new Map<string, CheckResult>();
  const checked: string[] = [];
  const follows: { url: string; token: string; ref: string }[] = [];
  const closed: string[] = [];
  const pushes: { url: string; token: string; ref: string }[] = [];
  let followed: ((ref: string) => { revision: string } | { skipped: string }) | undefined;
  const dir = mkdtempSync(join(tmpdir(), "sanoma-drafts-"));
  const draftAt = (id: string) => {
    const draft = drafts.get(id);
    if (!draft) throw new Error(`no draft ${id}`);
    return draft;
  };

  const source: Source = {
    root,
    commit: () => undefined,
    head(ref = "HEAD") {
      const id = draftOf(ref);
      if (id !== undefined) return draftAt(id).head;
      return remote?.branches.get("main") ?? sha("main");
    },
    async push(target) {
      pushes.push(target);
      const id = draftOf(target.ref);
      if (remote && id !== undefined) remote.push(target.ref, draftAt(id).head);
    },
    async draft(id) {
      const draft = draftAt(id);
      return { branch: draftBranch(id), root: draft.root, commit: () => undefined };
    },
    async drafts() {
      return [...drafts.keys()].toSorted();
    },
    async diff(id) {
      const files = [...draftAt(id).files.keys()].toSorted();
      return { files, summary: `${files.length} files changed` };
    },
    async closeDraft(id) {
      closed.push(id);
      drafts.delete(id);
    },
    async check(id) {
      checked.push(id);
      return checks.get(id) ?? { ok: true, problems: [], warnings: [] };
    },
    remoteUrl: async () => remote?.url,
    async follow(target) {
      follows.push(target);
      const answer = followed?.(target.ref);
      if (answer) return answer;
      // A draft's branch takes the host's commits on it.
      const id = draftOf(target.ref);
      const pushed = remote?.branches.get(target.ref);
      if (id !== undefined && pushed !== undefined) draftAt(id).head = pushed;
      return { revision: pushed ?? sha(target.ref) };
    },
  };

  return {
    source,
    checked,
    follows,
    closed,
    pushes,
    /**
     * Writes `files` (a path relative to the root and its text, or null to take back an edit of it)
     * in the draft `id`, made the first time, as one commit: its new head.
     */
    edit(id: string, files: Record<string, string | null>) {
      const draft = drafts.get(id) ?? { root: mkdtempSync(join(dir, `${id}-`)), files: new Map(), head: "", edits: 0 };
      drafts.set(id, draft);
      for (const [path, text] of Object.entries(files)) {
        if (text === null) {
          rmSync(join(draft.root, path), { force: true });
          draft.files.delete(path);
          continue;
        }
        mkdirSync(dirname(join(draft.root, path)), { recursive: true });
        writeFileSync(join(draft.root, path), text);
        draft.files.set(path, text);
      }
      draft.head = sha(`${id} ${++draft.edits}`);
      return draft.head;
    },
    /** What `check(id)` answers from now on. */
    checks(id: string, result: CheckResult) {
      checks.set(id, result);
    },
    /** What `follow` answers from now on. */
    following(answer: (ref: string) => { revision: string } | { skipped: string }) {
      followed = answer;
    },
    /** Deletes the drafts' directories. */
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
