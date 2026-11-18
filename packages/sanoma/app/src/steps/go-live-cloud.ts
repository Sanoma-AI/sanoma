import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppStepContext, CloudReady, GoLiveCloudInput, PushCloudInput } from "sanoma/workflows";
import { formatOptions, loadDataFiles, readLockfile, setFields } from "sanoma/workflows/describe";
import { cloudHostnameOf, cloudSlugOf } from "sanoma/workflows/shared";
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

/**
 * What must hold before going live on Sanoma Cloud, and the address: `infra.ts` declares a
 * database (`store`) and a host in a vendor's account (`host`, whose type offers its `account`'s
 * operations, `cloud.host`), the host is not bound (live, or made by another run), the Cloud token
 * is stored, and the worker has a repository to push. A new `address` is written into the file
 * (the host's `hostname`) and committed: the company is bound by its id, so a database made
 * already keeps it, and the host's create moves the company there. What the run then needs: the
 * slug, the operation that makes the repository, and whether `origin` names one.
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
  const { hostname } = host.desired;
  const declared = typeof hostname === "string" ? cloudSlugOf(hostname) : undefined;
  if (!declared) throw new Error(`${INFRA}'s host declares no address: declare its hostname, <slug>.sanoma.work`);
  let slug = declared;
  if (address !== undefined && address !== declared) {
    slug = address;
    await step.serially(async () => {
      const text = await readFile(join(root, INFRA), "utf8");
      const hosted = await setFields(text, "host", { hostname: cloudHostnameOf(slug) }, formatOptions(root));
      await written(step, INFRA, hosted, `Go live at ${cloudHostnameOf(slug)}`);
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
