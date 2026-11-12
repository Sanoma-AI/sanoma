import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppStepContext, CloudReady, GoLiveCloudInput, PushCloudInput } from "sanoma/workflows";
import { formatOptions, loadDataFiles, readLockfile, setFields } from "sanoma/workflows/describe";
import { INFRA } from "../api.ts";
import { accountOf, KEYS } from "../server/go-live.ts";
import { CLOUD_TOKEN, CLOUD_TOKEN_PATTERN } from "../server/sanoma-sign-in.ts";
import { gitAt } from "./connect.ts";
import { onMain } from "./go-live.ts";
import { rootOf, written } from "./writes.ts";

// Going live on Sanoma Cloud, in the worker (the built-in `go-live-cloud`): `infra.ts` declares the
// company's database and host there (the template's), and the run applies them as they are. First
// what must hold and the address written when the person changed it; then, once the run made the
// repository in the Cloud's account (its own operation, through `ctx`), `origin` set to it and
// `main` pushed; then the run applies the database and the host and waits for them.

/** The address a host's slug names at Sanoma Cloud. */
const hostnameOf = (slug: string) => `${slug}.sanoma.work`;

/**
 * What must hold before going live on Sanoma Cloud, and the address: `infra.ts` declares a
 * database (`store`) and a host in a vendor's account (`host`, whose type offers its `account`'s
 * operations, `cloud.host`), the host is not bound (live, or made by another run), the Cloud token
 * is stored, and the worker has a repository to push. A new `address` is written into the file
 * (`name` of both, the host's `hostname`) and committed, unless the database is made already, whose
 * name cannot change. What the run then needs: the slug, the operation that makes the repository,
 * and whether `origin` names one.
 */
export async function goLiveCloud(step: AppStepContext, { address }: GoLiveCloudInput): Promise<CloudReady> {
  const { client, source, resolved } = step;
  const root = rootOf(step);
  const infra = await readFile(join(root, INFRA), "utf8").catch(() => "");
  const account = accountOf(step, infra);
  // The declarations as the data files load them, by their keys.
  const { resources } = loadDataFiles(root, step.config.connectors, resolved.types);
  const store = resources.find((r) => r.id === KEYS.store);
  const host = resources.find((r) => r.id === KEYS.host);
  if (!account || !host || !resolved.types.get(`${store?.vendor}.${store?.type}`)?.database) {
    throw new Error(
      `${INFRA} declares no database and host on Sanoma Cloud: go live on your own accounts, from Hosting`,
    );
  }
  if (!resolved.drivers.has(account.repository)) {
    throw new Error(`${account.repository} has no driver: install the Sanoma Cloud connector of this release`);
  }
  const { bindings } = readLockfile(root);
  if (bindings[KEYS.host]) throw new Error("The host is made already: the company is live");
  const token = (await client.secrets([CLOUD_TOKEN])).get(CLOUD_TOKEN)?.value;
  if (!token || !CLOUD_TOKEN_PATTERN.test(token)) {
    throw new Error("Sign in to Sanoma first, on Hosting, or paste a Cloud token there");
  }
  if (!source?.pushOrigin || !source.remoteUrl) throw new Error("The worker has no repository to push from");
  const declared = host.desired.name;
  if (typeof declared !== "string" || !declared) {
    throw new Error(`${INFRA}'s host declares no name: declare its slug, as name`);
  }
  let slug = declared;
  if (address !== undefined && address !== declared) {
    if (bindings[KEYS.store]) {
      throw new Error(`The database is made already, for ${hostnameOf(declared)}: its address cannot change now`);
    }
    slug = address;
    await step.serially(async () => {
      const options = formatOptions(root);
      const text = await readFile(join(root, INFRA), "utf8");
      const named = store!.desired.name === undefined ? text : await setFields(text, "store", { name: slug }, options);
      const hosted = await setFields(named, "host", { name: slug, hostname: hostnameOf(slug) }, options);
      await written(step, INFRA, hosted, `Go live at ${hostnameOf(slug)}`);
    });
  }
  return { slug, account: account.repository, origin: (await source.remoteUrl()) !== undefined };
}

/** A GitHub owner and repository name, as `connect-existing` takes them: nothing that could leave the path. */
const OWNER = /^[\w-]+$/;
const NAME = /^(?!\.\.?$)[\w.-]+$/;

/**
 * `origin` set to the repository made in the Cloud's account (`repository`, when `origin` named
 * none: its owner and name checked, then given to git as one argument, never through a shell),
 * then `main` pushed there with git's own sign-in, as apply reads it to deploy (a host's revision
 * is `git ls-remote`'s): never a token in the URL or the config. Then the database and the host,
 * for the run to apply.
 */
export async function pushCloud(step: AppStepContext, { repository }: PushCloudInput) {
  const { source } = step;
  if (!source?.pushOrigin) throw new Error("The worker has no repository to push from");
  if (repository && !(OWNER.test(repository.owner) && NAME.test(repository.name))) {
    throw new Error("Sanoma Cloud answered with a repository that is no GitHub owner/name");
  }
  await step.serially(async () => {
    await onMain(source);
    // Unless this step set it already, when it runs again.
    if (repository && (await source.remoteUrl?.()) === undefined) {
      const git = await gitAt(source.root);
      if (!git) throw new Error("The worker's repository is not a git checkout");
      await git("remote", "add", "origin", `https://github.com/${repository.owner}/${repository.name}.git`);
    }
    await source.pushOrigin!();
  });
  return { apply: { only: [KEYS.store, KEYS.host] } };
}
