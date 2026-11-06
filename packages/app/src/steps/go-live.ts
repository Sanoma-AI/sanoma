import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AppStepContext,
  databaseUrlSecret,
  deploymentKey,
  errorMessage,
  DEPLOY_KEY_TITLE,
  type GoLiveHostInput,
  type GoLiveInput,
  installedSanoma,
  runtimeImage,
  SOURCE_KEY,
  sourceKeyPair,
  type RepoRef,
  type Resource,
  VENDOR,
  vendorCodeOf,
} from "@sanoma-ai/workflows";
import { type DataValue, formatOptions, readLockfile, Reference, renderDataFile } from "@sanoma-ai/workflows/describe";
import { secret } from "@sanoma-ai/workflows/resources";
import { INFRA } from "../api.ts";
import { invalid } from "../server/core.ts";
import {
  beforeHost,
  choose,
  DATABASE_EXTRAS,
  DOCKER,
  githubOf,
  idOf,
  KEYS,
  missingTypes,
  toConnect,
} from "../server/go-live.ts";
import { mintWakeupToken } from "../server/setup.ts";
import { rootOf } from "./writes.ts";

// Going live's writes, in the worker (the built-ins `go-live` and `go-live-host`): `infra.ts`
// rendered from the choices and written, committed, and the repository pushed to the one apply
// made; each run then starts the apply (`server/go-live.ts` has what the page reads).

/** What rendering `infra.ts` reads: the config, its resolution, and the client the connections are read through. */
export type Rendering = Pick<AppStepContext, "config" | "resolved" | "client">;

/** The runtime image a container on this machine runs: `docker build -t sanoma-runtime packages/sanoma/runtime`. */
const RUNTIME_IMAGE = "sanoma-runtime";

/** The secret the database's URL is stored in: its `storeUrl` for the export `store`. */
const DATABASE_URL = databaseUrlSecret("store");
const SECRETS_KEY = "SANOMA_SECRETS_KEY";

/** Whether `infra` declares the export `name`, as `renderInfra` writes it. */
const declares = (infra: string, name: string) => new RegExp(`^export const ${name} = `, "m").test(infra);
/** The repository's owner and name in `infra.ts` as `renderInfra` writes them. */
const REPO = /export const repo = github\.repository\(\{\s*owner: "([^"]+)",\s*name: "([^"]+)"/;

const hasField = (type: Resource, field: string) => field in (type.schema.shape as Record<string, unknown>);

/** `into`, with `value` at its dotted `path`, the objects on the way made. */
function setPath(into: Record<string, DataValue>, path: string, value: DataValue): Record<string, DataValue> {
  const keys = path.split(".");
  const last = keys.pop()!;
  let at = into;
  for (const key of keys) at = (at[key] ??= {}) as Record<string, DataValue>;
  at[last] = value;
  return into;
}

/** The version of `sanoma` the company's repository installs (`installedSanoma`), which the host's runtime image is tagged with. */
async function sanomaVersion(root: string): Promise<string> {
  const version = await installedSanoma(root);
  if (version === undefined)
    throw new Error(`sanoma is not installed in the company's repository (${root}): install it`);
  return version;
}

/**
 * `infra.ts`'s text for the choices: the repository, with the owner chosen, the database, the
 * host that runs the company from them, once a wakeup for the host is connected, the wakeup
 * that starts the host again, and once a sandbox's vendor is (Agent37's key), the box its coding
 * agents work in (`box`), with its type's defaults. A host that derives (`cloudflare.host`) is declared by its
 * decisions alone, its name and its database: apply gives it the rest, the read-only deploy key
 * it clones with among them (`deriveHosts`). Any other host (`docker.container`) names its image,
 * source, ref, port and secrets, and its deploy key is declared beside it (`deployKey`, the public
 * half of `SANOMA_SOURCE_KEY`).
 */
export async function renderInfra(
  step: Rendering,
  { owner, name, organization, region, size, database: shownDatabase, host: shown, port }: GoLiveInput,
  deployKey?: string,
  chosen?: Awaited<ReturnType<typeof choose>>,
) {
  const root = rootOf(step);
  const { database, host, wakeup, sandbox: connected } = chosen ?? (await choose(step));
  // The box, unless another data file declares one already: a second would leave both out. Either
  // way the host is given its vendor's key, so that the live instance opens its boxes.
  const [boxed] = await step.resolved.sandboxes();
  const sandbox = boxed ? undefined : connected;
  const missing = missingTypes(step);
  if (missing.length || !host || !database) {
    throw new Error(`The config's connectors declare no ${missing.join(", ")}: add them to sanoma.config.ts`);
  }
  // What is connected changed since the page chose (Cloudflare or Supabase connected meanwhile, say).
  if (shown !== undefined && shown !== idOf(host)) {
    throw new Error(`Going live now runs the company on ${idOf(host)}, not ${shown}: reload the page`);
  }
  if (shownDatabase !== undefined && shownDatabase !== idOf(database)) {
    throw new Error(
      `Going live now keeps the company's records in ${idOf(database)}, not ${shownDatabase}: reload the page`,
    );
  }
  const constructors = (vendor: string) => {
    // The runtime's own (`sanoma.wakeup`) is in no connector of the config's; else the first connector of the vendor's names it.
    const pkg =
      vendor === "sanoma"
        ? "sanoma"
        : step.config.connectors.find((c) => c[VENDOR].id === vendor)?.[VENDOR].info?.package;
    if (!pkg) throw new Error(`The ${vendor} connector names no package to import from`);
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
    await sanomaVersion(root);
  }
  const declared = derives
    ? hosted
    : await declaredHost(step, host, hosted, port, {
        ...wakeup.secrets,
        ...(await vendorSecrets(step, (boxed ?? sandbox)?.vendor)),
      });
  if (!derives && !deployKey) throw new Error("A host that does not derive is declared with its deploy key");
  const woken = wakeup.type;
  return renderDataFile(
    {
      imports: [
        ...new Set(
          ["github", database.vendor, host.vendor, woken?.vendor, sandbox?.vendor].filter(
            (vendor) => vendor !== undefined,
          ),
        ),
      ].map(constructors),
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
        // The coding agents' box, with its type's defaults.
        ...(sandbox ? [{ name: "box", vendor: sandbox.vendor, type: sandbox.type, desired: {} }] : []),
      ],
    },
    formatOptions(root),
  );
}

/**
 * A host that does not derive, as `infra.ts` declares it: its image (this machine's for Docker's,
 * else the published one of the installed sanoma), its source and ref, its secrets (each a
 * `secret(...)`, never a value: the runtime's, `extra` and the sign-in sender's) and its port.
 */
async function declaredHost(
  step: Rendering,
  host: Resource,
  hosted: Record<string, DataValue>,
  port: number | undefined,
  /** The wakeup's and the sandbox's secrets it is given besides the runtime's. */
  extra: Record<string, DataValue>,
): Promise<Record<string, DataValue>> {
  const { inputs } = host.host!;
  if (hasField(host, "image")) {
    hosted.image = idOf(host) === DOCKER ? RUNTIME_IMAGE : runtimeImage(await sanomaVersion(rootOf(step)));
  }
  setPath(hosted, inputs.source, new Reference("repo"));
  setPath(hosted, inputs.ref, "main");
  // `offered` leaves out a host that binds its own bootstrap, the one kind with no secrets.
  if (!inputs.secrets) throw new Error(`${host.title} binds its own bootstrap: going live does not write its file yet`);
  setPath(hosted, inputs.secrets, {
    SANOMA_DATABASE_URL: secret(DATABASE_URL),
    SANOMA_SIGNING_KEY: secret("SANOMA_SIGNING_KEY"),
    ...(!step.resolved.secrets.store && { SANOMA_SECRETS_KEY: secret(SECRETS_KEY) }),
    [SOURCE_KEY]: secret(SOURCE_KEY),
    ...extra,
    ...(await vendorSecrets(step, step.resolved.login?.sender?.vendor)),
  });
  if (inputs.port && port !== undefined) setPath(hosted, inputs.port, port);
  return hosted;
}

/**
 * Step 3: writes `infra.ts` for the choices (the repository with its owner) and commits it; its
 * run then applies the repository, the deploy key the host clones it with and the database
 * (step 4). For a host that derives, apply mints the key (its private half stored as
 * `SANOMA_SOURCE_KEY`) and declares its public half on the repository; for any other, going live
 * mints it here and the file declares it. Apply creates them, binds them in the lockfile and, once
 * the project is healthy, stores its database URL (its `afterCreate`). Refused once the file is
 * written: going live writes it once.
 */
export async function goLive(step: AppStepContext, choices: GoLiveInput) {
  const { client, source, by } = step;
  const path = join(rootOf(step), INFRA);
  if (existsSync(path)) throw writtenAlready();
  // Host bootstrap follows the same direct-or-mounted-file rules as the runtime. An external
  // store has its own authority and does not need the built-in store's encryption key.
  const bootstrap: ("SANOMA_SIGNING_KEY" | "SANOMA_SECRETS_KEY")[] = ["SANOMA_SIGNING_KEY"];
  if (!step.resolved.secrets.store) bootstrap.push(SECRETS_KEY);
  for (const name of bootstrap) {
    try {
      deploymentKey(name);
    } catch {
      throw new Error(`Configure ${name} or ${name}_FILE before going live`);
    }
  }
  // The GitHub connector makes the repository with a token of the person's own: an App's
  // installation alone cannot yet.
  const chosen = await choose(step, by);
  if (!chosen.stored.tokens.has("GITHUB_TOKEN")) {
    throw new Error("The GitHub connector creates the repository with GITHUB_TOKEN: connect a token");
  }
  // The database's and the host's vendors connected: their tokens are what apply makes them with.
  const connect = toConnect(chosen);
  if (connect.length) throw new Error(`Connect ${connect.join(" and ")} first`);
  // A host that derives is given its deploy key by apply, which mints it. Any other: a new key each
  // time, since GitHub takes a key for one repository only, and none declares this one yet.
  const key = chosen.host?.host?.derives ? undefined : await sourceKeyPair();
  const text = await renderInfra(step, choices, key?.publicKey, chosen);
  await step.serially(async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
      throw err.code === "EEXIST" ? writtenAlready() : err;
    });
    try {
      if (key) await client.setSecret(SOURCE_KEY, key.privateKey, { by: by.id });
      // Once the request is good: a wakeup's token may be the environment's or its connector page's, which mint nothing.
      if (chosen.wakeup.type) await mintWakeupToken(client, by);
    } catch (err) {
      // Unwritten again, so going live can be tried again.
      await rm(path, { force: true });
      throw err;
    }
    await source?.commit({
      paths: [INFRA],
      message: "Go live: declare the repository, its deploy key, the database and the host",
      author: by.id,
    });
  });
  return { apply: { only: beforeHost(step, text) } };
}

const writtenAlready = () => new Error(`${INFRA} is written already: change it in the file, and apply from Hosting`);

/**
 * The token a push to `repo` signs in with, from the GitHub connector's remote half: the stored
 * `GITHUB_TOKEN`, else an installation token of the GitHub App installed on the owner.
 */
async function pushToken(step: AppStepContext, repo: RepoRef): Promise<string> {
  const { remote, context } = githubOf(step);
  if (!remote) {
    throw new Error("The GitHub connector has no remote half: install @sanoma-ai/connector-github of this release");
  }
  try {
    return await remote.open(repo, context).token("token");
  } catch (err) {
    // Neither a token nor the App: something to connect, not GitHub failing, which says so itself.
    if (vendorCodeOf(err) === "no_token") throw new Error(errorMessage(err), { cause: err });
    throw err;
  }
}

/**
 * Step 5: pushes the local repository's `main`, with `infra.ts` and the lockfile on top, to the
 * repository apply made; its run then applies the host (and its wakeup, when declared), step 6.
 * Refused until the repository, its deploy key (which the host clones with) and the database are
 * bound.
 */
export async function goLiveHost(step: AppStepContext, _input: GoLiveHostInput) {
  const { client, source } = step;
  const root = rootOf(step);
  const { bindings } = readLockfile(root);
  const infra = await readFile(join(root, INFRA), "utf8").catch(() => "");
  if (beforeHost(step, infra).some((key) => !bindings[key])) {
    throw new Error("Apply the repository, its deploy key and the database first");
  }
  if (!source?.push) throw new Error("The worker has no repository to push from");
  // The database's `afterCreate` stores it (its `storeUrl`); one bound without it (a hook that failed) cannot run a host.
  if (!(await client.secrets([DATABASE_URL])).has(DATABASE_URL)) {
    throw new Error(`${DATABASE_URL} is not stored: the database's URL was not stored after its create`);
  }
  await step.serially(async () => {
    // What is pushed is `main`, where going live committed: refused on another branch.
    if ((await source.head()) !== (await Promise.resolve(source.head("main")).catch(() => undefined))) {
      throw new Error("Check out main, where infra.ts and the lockfile are committed, then push");
    }
    // The repository's owner and name as going live wrote them, first in the file.
    const [, owner, name] = REPO.exec(infra) ?? [];
    if (!owner || !name) throw new Error(`Cannot tell the repository from ${INFRA}`);
    await source.push!({
      url: `https://github.com/${owner}/${name}.git`,
      token: await pushToken(step, { owner, name }),
      ref: "main",
    });
  });
  // The wakeup, when declared, after the host it names, and the box: one apply, in dependency order.
  const only = [
    KEYS.host,
    ...(["wakeup", "box"] as const).filter((name) => declares(infra, name)).map((name) => KEYS[name]),
  ];
  return { apply: { only } };
}

/**
 * The variables `vendor`'s driver reads, as the host's secrets: each it declares (Resend's
 * `RESEND_API_KEY`), one the driver marks optional only once stored, so the host calls the vendor
 * as this app does: the sign-in sender's (`login.sender`), so it sends sign-in codes, and the
 * sandbox's, so its coding agents open their boxes. None without a vendor.
 */
async function vendorSecrets({ client }: Rendering, vendor: string | undefined): Promise<Record<string, DataValue>> {
  if (!vendor) return {};
  const statuses = (await client.credentials()).get(vendor) ?? [];
  return Object.fromEntries(
    statuses.filter((c) => c.status === "set" || !c.optional).map((c) => [c.name, secret(c.name)]),
  );
}
