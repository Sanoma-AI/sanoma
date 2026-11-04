// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  deploymentKey,
  errorMessage,
  DEPLOY_KEY_TITLE,
  installedSanoma,
  type Principal,
  runtimeImage,
  SOURCE_KEY,
  sourceKeyPair,
  type RepoRef,
  type Resource,
  vendorCodeOf,
} from "@sanoma-ai/workflows";
import { type DataValue, formatOptions, readLockfile, Reference, renderDataFile } from "@sanoma-ai/workflows/describe";
import { secret } from "@sanoma-ai/workflows/resources";
import { ApiError, INFRA, type GoLiveRequest } from "../../api.ts";
import type { AppContext } from "../../context.ts";
import { invalid } from "../core.ts";
import {
  beforeHost,
  choose,
  DATABASE_EXTRAS,
  DATABASE_URL,
  DOCKER,
  githubOf,
  hasField,
  idOf,
  KEYS,
  missingTypes,
  REPO,
  RUNTIME_IMAGE,
  SECRETS_KEY,
  setPath,
  toConnect,
  WAKEUP_LINE,
} from "../go-live.ts";
import { mintWakeupToken } from "../setup.ts";

// Going live's writes, where the checkout is: `infra.ts` rendered from the choices and written,
// committed, and the repository pushed to the one apply made (`go-live.ts` has the rest).

/** The version of `sanoma` the company's repository installs (`installedSanoma`), which the host's runtime image is tagged with. */
async function sanomaVersion(root: string): Promise<string> {
  const version = await installedSanoma(root);
  if (version === undefined) {
    throw new ApiError(409, { error: `sanoma is not installed in the company's repository (${root}): install it` });
  }
  return version;
}

/**
 * `infra.ts`'s text for the choices: the repository, with the owner chosen, the database, the
 * host that runs the company from them and, once a wakeup for the host is connected, the wakeup
 * that starts the host again. A host that derives (`cloudflare.host`) is declared by its
 * decisions alone, its name and its database: apply gives it the rest, the read-only deploy key
 * it clones with among them (`deriveHosts`). Any other host (`docker.container`) names its image,
 * source, ref, port and secrets, and its deploy key is declared beside it (`deployKey`, the public
 * half of `SANOMA_SOURCE_KEY`).
 */
export async function renderInfra(
  app: AppContext,
  { owner, name, organization, region, size, database: shownDatabase, host: shown, port }: GoLiveRequest,
  deployKey?: string,
  chosen?: Awaited<ReturnType<typeof choose>>,
) {
  const { database, host, wakeup } = chosen ?? (await choose(app));
  const vendors = app.snapshot.description.vendors;
  const missing = missingTypes(app);
  if (missing.length || !host || !database) {
    throw new ApiError(409, {
      error: `The config's connectors declare no ${missing.join(", ")}: add them to sanoma.config.ts`,
    });
  }
  // What is connected changed since the page chose (Cloudflare or Supabase connected meanwhile, say).
  if (shown !== undefined && shown !== idOf(host)) {
    throw new ApiError(409, {
      error: `Going live now runs the company on ${idOf(host)}, not ${shown}: reload the page`,
    });
  }
  if (shownDatabase !== undefined && shownDatabase !== idOf(database)) {
    throw new ApiError(409, {
      error: `Going live now keeps the company's records in ${idOf(database)}, not ${shownDatabase}: reload the page`,
    });
  }
  const constructors = (vendor: string) => {
    // The runtime's own (`sanoma.wakeup`) is in no connector of the config's.
    const pkg = vendor === "sanoma" ? "sanoma" : vendors[vendor]?.package;
    if (!pkg) throw new ApiError(409, { error: `The ${vendor} connector names no package to import from` });
    return { source: `${pkg}/resources`, imported: vendor, local: vendor };
  };

  const { inputs: dbInputs, regions } = database.database!;
  if (regions && !regions.includes(region)) invalid("region", `${database.title} has no region ${region}`);
  if (size && !dbInputs.size) invalid("size", `${database.title} takes no size: reload the page`);
  const store: Record<string, DataValue> = { ...(hasField(database, "name") && { name }) };
  setPath(store, dbInputs.region, region);
  if (size) setPath(store, dbInputs.size!, size);
  Object.assign(store, DATABASE_EXTRAS[idOf(database)]?.({ ...(organization && { organization }) }));

  const { inputs, derives } = host.host!;
  const hosted: Record<string, DataValue> = { ...(hasField(host, "name") && { name }) };
  if (derives) {
    if (inputs.database) setPath(hosted, inputs.database, new Reference("store"));
    // The installed sanoma is what the host's image is tagged with: refused here when there is none.
    await sanomaVersion(app.resolved.root!);
  }
  const declared = derives ? hosted : await declaredHost(app, host, hosted, port, wakeup.secrets);
  if (!derives && !deployKey) throw new Error("A host that does not derive is declared with its deploy key");
  const woken = wakeup.type;
  return renderDataFile(
    {
      imports: [...new Set(["github", database.vendor, host.vendor, ...(woken ? [woken.vendor] : [])])].map(
        constructors,
      ),
      exports: [
        { name: "repo", vendor: "github", type: "repository", desired: { owner, name, visibility: "private" } },
        ...(derives
          ? []
          : [
              {
                name: "deployKey",
                vendor: "github",
                type: "repository_deploy_key",
                desired: {
                  repository: new Reference("repo"),
                  title: DEPLOY_KEY_TITLE,
                  key: deployKey!,
                  read_only: true,
                },
              },
            ]),
        { name: "store", vendor: database.vendor, type: database.type, desired: store },
        { name: "host", vendor: host.vendor, type: host.type, desired: declared },
        ...(woken
          ? [
              {
                name: "wakeup",
                vendor: woken.vendor,
                type: woken.type,
                desired: setPath({}, woken.wakeup!.inputs.host, new Reference("host")),
              },
            ]
          : []),
      ],
    },
    formatOptions(app.resolved.root!),
  );
}

/**
 * A host that does not derive, as `infra.ts` declares it: its image (this machine's for Docker's,
 * else the published one of the installed sanoma), its source and ref, its secrets (each a
 * `secret(...)`, never a value) and its port.
 */
async function declaredHost(
  app: AppContext,
  host: Resource,
  hosted: Record<string, DataValue>,
  port: number | undefined,
  wakeupSecrets: Record<string, DataValue> | undefined,
): Promise<Record<string, DataValue>> {
  const { inputs } = host.host!;
  if (hasField(host, "image")) {
    hosted.image = idOf(host) === DOCKER ? RUNTIME_IMAGE : runtimeImage(await sanomaVersion(app.resolved.root!));
  }
  setPath(hosted, inputs.source, new Reference("repo"));
  setPath(hosted, inputs.ref, "main");
  // `offered` leaves out a host that binds its own bootstrap, the one kind with no secrets.
  if (!inputs.secrets) {
    throw new ApiError(409, { error: `${host.title} binds its own bootstrap: going live does not write its file yet` });
  }
  setPath(hosted, inputs.secrets, {
    SANOMA_DATABASE_URL: secret(DATABASE_URL),
    SANOMA_SIGNING_KEY: secret("SANOMA_SIGNING_KEY"),
    ...(!app.resolved.secrets.store && { SANOMA_SECRETS_KEY: secret(SECRETS_KEY) }),
    [SOURCE_KEY]: secret(SOURCE_KEY),
    ...wakeupSecrets,
    ...(await senderSecrets(app)),
  });
  if (inputs.port && port !== undefined) setPath(hosted, inputs.port, port);
  return hosted;
}

/**
 * Step 3 and 4: writes `infra.ts` for the choices (the repository with its owner), commits it,
 * and starts apply on the repository, the deploy key the host clones it with and the database.
 * For a host that derives, apply mints the key (its private half stored as `SANOMA_SOURCE_KEY`)
 * and declares its public half on the repository; for any other, going live mints it here and
 * the file declares it. Apply creates them, binds them in the lockfile and, once the project is
 * healthy, stores its database URL (its `afterCreate`). Refused once the file is written: going
 * live writes it once.
 */
export async function goLive(app: AppContext, actor: Principal, choices: GoLiveRequest): Promise<{ runId: string }> {
  const { client, resolved } = app;
  const source = app.local?.source;
  if (resolved.root === undefined) throw new Error("The config has no root, so its data files cannot be written");
  const path = join(resolved.root, INFRA);
  if (existsSync(path)) throw writtenAlready();
  // Host bootstrap follows the same direct-or-mounted-file rules as the runtime. An external
  // store has its own authority and does not need the built-in store's encryption key.
  const bootstrap: ("SANOMA_SIGNING_KEY" | "SANOMA_SECRETS_KEY")[] = ["SANOMA_SIGNING_KEY"];
  if (!resolved.secrets.store) bootstrap.push(SECRETS_KEY);
  for (const name of bootstrap) {
    try {
      deploymentKey(name);
    } catch {
      throw new ApiError(409, { error: `Configure ${name} or ${name}_FILE before going live` });
    }
  }
  // The GitHub connector makes the repository with a token of the person's own: an App's
  // installation alone cannot yet.
  const chosen = await choose(app, actor);
  if (!chosen.stored.tokens.has("GITHUB_TOKEN")) {
    throw new ApiError(409, {
      error: "The GitHub connector creates the repository with GITHUB_TOKEN: connect a token",
    });
  }
  // The database's and the host's vendors connected: their tokens are what apply makes them with.
  const connect = toConnect(chosen);
  if (connect.length) throw new ApiError(409, { error: `Connect ${connect.join(" and ")} first` });
  // A host that derives is given its deploy key by apply, which mints it. Any other: a new key each
  // time, since GitHub takes a key for one repository only, and none declares this one yet.
  const key = chosen.host?.host?.derives ? undefined : await sourceKeyPair();
  const text = await renderInfra(app, choices, key?.publicKey, chosen);
  await mkdir(dirname(path), { recursive: true });
  // Exclusive, before the key is stored: of two requests at once, one writes its public half and
  // stores its private half, and the other is refused.
  await writeFile(path, text, { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
    throw err.code === "EEXIST" ? writtenAlready() : err;
  });
  try {
    if (key) await client.setSecret(SOURCE_KEY, key.privateKey, { by: actor.id });
    // Once the request is good: a wakeup's token may be the environment's or its connector page's, which mint nothing.
    if (chosen.wakeup.type) await mintWakeupToken(client, actor);
  } catch (err) {
    // Unwritten again, so going live can be tried again.
    await rm(path, { force: true });
    throw err;
  }
  await source?.commit({
    paths: [INFRA],
    message: "Go live: declare the repository, its deploy key, the database and the host",
    author: actor.id,
  });
  const runId = await client.apply({ only: beforeHost(app, text) }, { startedBy: actor });
  return { runId };
}

const writtenAlready = () =>
  new ApiError(409, { error: `${INFRA} is written already: change it in the file, and apply from Hosting` });

/**
 * The token a push to `repo` signs in with, from the GitHub connector's remote half: the stored
 * `GITHUB_TOKEN`, else an installation token of the GitHub App installed on the owner.
 */
async function pushToken(app: AppContext, repo: RepoRef): Promise<string> {
  const { remote, context } = githubOf(app);
  if (!remote)
    throw new ApiError(409, {
      error: "The GitHub connector has no remote half: install @sanoma-ai/connector-github of this release",
    });
  try {
    return await remote.open(repo, context).token("token");
  } catch (err) {
    // Neither a token nor the App: something to connect, not GitHub failing.
    if (vendorCodeOf(err) === "no_token") throw new ApiError(409, { error: errorMessage(err) });
    throw err;
  }
}

/**
 * Steps 5 and 6: pushes the local repository's `main`, with `infra.ts` and the lockfile on top,
 * to the repository apply made, then starts apply on the host (and its wakeup, when declared).
 * Refused until the repository, its deploy key (which the host clones with) and the database are
 * bound.
 */
export async function goLiveHost(app: AppContext, actor: Principal): Promise<{ runId: string }> {
  const { client, resolved } = app;
  const source = app.local?.source;
  const { bindings } = readLockfile(resolved.root!);
  const infra = await readFile(join(resolved.root!, INFRA), "utf8").catch(() => "");
  if (beforeHost(app, infra).some((key) => !bindings[key])) {
    throw new ApiError(409, { error: "Apply the repository, its deploy key and the database first" });
  }
  if (!source?.push) throw new ApiError(409, { error: "The app has no repository to push from" });
  // The database's `afterCreate` stores it (its `storeUrl`); one bound without it (a hook that failed) cannot run a host.
  if (!(await client.secrets([DATABASE_URL])).has(DATABASE_URL)) {
    throw new ApiError(409, {
      error: `${DATABASE_URL} is not stored: the database's URL was not stored after its create`,
    });
  }
  // What is pushed is `main`, where going live committed: refused on another branch.
  if ((await source.head()) !== (await Promise.resolve(source.head("main")).catch(() => undefined))) {
    throw new ApiError(409, { error: "Check out main, where infra.ts and the lockfile are committed, then push" });
  }
  // The repository's owner and name as going live wrote them, first in the file.
  const [, owner, name] = REPO.exec(infra) ?? [];
  if (!owner || !name) throw new ApiError(409, { error: `Cannot tell the repository from ${INFRA}` });
  try {
    await source.push({
      url: `https://github.com/${owner}/${name}.git`,
      token: await pushToken(app, { owner, name }),
      ref: "main",
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, { error: errorMessage(err) });
  }
  // The wakeup, when declared, after the host it names: one apply, in dependency order.
  const only = WAKEUP_LINE.test(infra) ? [KEYS.host, KEYS.wakeup] : [KEYS.host];
  const runId = await client.apply({ only }, { startedBy: actor });
  return { runId };
}

/**
 * The variables the config's sign-in sender (`login.sender`) reads, as the host's secrets: each
 * its driver declares (Resend's `RESEND_API_KEY`), one the driver marks optional only once stored,
 * so the host sends sign-in codes as this app does. None without a sender.
 */
async function senderSecrets({ client, resolved }: AppContext): Promise<Record<string, DataValue>> {
  const sender = resolved.login?.sender;
  if (!sender) return {};
  const statuses = (await client.credentials()).get(sender.vendor) ?? [];
  return Object.fromEntries(
    statuses.filter((c) => c.status === "set" || !c.optional).map((c) => [c.name, secret(c.name)]),
  );
}
