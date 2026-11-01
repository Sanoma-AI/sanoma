import { createServer, request as forward, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DriverError, errorMessage } from "@sanoma-ai/workflows";
import { defineFake, type FakeOptions } from "@sanoma-ai/workflows/fake";
import { REGIONS, cloudOps, SLUG } from "./connector.ts";
import { type CloudApi, cloudOperations, type Company } from "./operations.ts";

/** A `GET /wake` a host's runtime answered: when. */
export interface FakeWake {
  at: Date;
}

/** What `start` runs for a company's host: a runtime answering at `url`, until `stop`. */
export interface FakeRuntime {
  url: string;
  stop(): Promise<void>;
  /** Each `/wake` it answered, in order, when it records them. */
  wakes?: readonly FakeWake[];
}

/** Starts a company's runtime at a revision, as the Cloud's container would, its bootstrap the Cloud's own. */
export type StartRuntime = (input: { slug: string; revision: string }) => Promise<FakeRuntime>;

export interface FakeCloudOptions extends FakeOptions {
  /** What a host runs. Default: a stub that answers `/healthz` 200 and `/wake` 204. */
  start?: StartRuntime;
}

/** A company as the fake Cloud keeps it: the parts it has. */
export interface FakeCompany {
  slug: string;
  name: string;
  repository?: { owner: string; name: string; ref: string };
  database?: { id: string; region: string };
  host?: { revision: string; domains?: Record<string, string> };
}

export interface FakeCloudState extends Record<string, unknown> {
  /** Counts up, for ids made in order. */
  seq: number;
  /** The token's companies, by slug. */
  companies: Record<string, FakeCompany>;
}

/** A company's workflow refusing, as sanoma-ops's do: the run fails, which the api answers 422, and its call with it. */
const fail = (workflow: string, message: string) =>
  new DriverError(`Sanoma Cloud: ${workflow}: ${message}`, { retryable: false, status: 422 });

/** A runtime that answers `/healthz` and records each `/wake`: what a host runs unless the fake is given `start`. */
const stubRuntime: StartRuntime = async () => {
  const wakes: FakeWake[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://runtime").pathname;
    if (path === "/healthz") return void res.writeHead(200).end("ok\n");
    if (path !== "/wake") return void res.writeHead(404).end();
    wakes.push({ at: new Date() });
    res.writeHead(204).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  server.unref();
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    wakes,
    stop: () => new Promise<void>((done) => server.close(() => done())),
  };
};

/**
 * A company's address in this process, as `<slug>.sanoma.work` is: a server made at its first
 * host, kept for the fake's life, that starts the runtime on a request while the host is there
 * (one start at a time) and forwards the request to it, and answers 404 while there is none.
 */
function address(start: StartRuntime, started: FakeRuntime[]) {
  let revision: string | undefined;
  let runtime: Promise<FakeRuntime> | undefined;
  let server: Server | undefined;
  let url: string | undefined;
  const up = (slug: string) =>
    (runtime ??= start({ slug, revision: revision! }).then(
      (made) => {
        started.push(made);
        return made;
      },
      (err: unknown) => {
        runtime = undefined;
        throw err;
      },
    ));
  /** Stops the runtime, the address kept: the next request starts it again. */
  const suspend = async () => {
    const was = runtime;
    runtime = undefined;
    await was?.then(
      (made) => made.stop(),
      () => undefined,
    );
  };
  return {
    /** Runs the host at `revision`, now: a new revision stops the runtime that ran the old one. */
    async run(slug: string, at: string): Promise<string> {
      if (revision !== at) await suspend();
      revision = at;
      if (!server) {
        server = createServer((req, res) => {
          if (revision === undefined) return void res.writeHead(404).end("There is nothing here yet\n");
          up(slug).then(
            (made) => {
              const out = forward(
                new URL(req.url ?? "/", made.url),
                { method: req.method, headers: req.headers },
                (answer) => {
                  res.writeHead(answer.statusCode ?? 502, answer.headers);
                  answer.pipe(res);
                },
              );
              out.once("error", (err) =>
                res.headersSent ? res.destroy() : res.writeHead(502).end(`${errorMessage(err)}\n`),
              );
              req.pipe(out);
            },
            (err: unknown) => res.writeHead(502).end(`${errorMessage(err)}\n`),
          );
        });
        await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
        // A fake no one closes, as a sandbox run's, keeps no process up.
        server.unref();
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      }
      await up(slug);
      return url!;
    },
    suspend,
    /** The host is gone: the runtime stops, and the address answers 404. */
    async remove() {
      revision = undefined;
      await suspend();
    },
    async close() {
      await this.remove();
      server?.closeAllConnections();
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      server = undefined;
    },
    get url() {
      return url;
    },
  };
}

/**
 * An in-memory Sanoma Cloud for tests: the token's companies in `state.companies`, keyed by slug,
 * each with the parts `cloud-signup` made (a database `fake-db-<n>` in its region, `us-east` by
 * default; a host at its revision), every part healthy. A host runs `start`'s runtime behind an
 * address in this process that outlives it (`<slug>.sanoma.work`'s stand-in), which starts it on
 * a request; a deploy moves it to the new revision; a close removes the part, and the company with
 * its last. `stop(slug)` stops a host's runtime as a quiet spell would, the address kept; `wakes()`
 * lists the `/wake`s the runtimes answered; `close()` (and `reset()`) stops everything. It refuses
 * what sanoma-ops's workflows refuse: a slug that is not one, a region the Cloud has not, a host
 * with no repository, a deploy of a company with no host.
 */
export function fakeCloud(options: FakeCloudOptions = {}) {
  const start = options.start ?? stubRuntime;
  const addresses = new Map<string, ReturnType<typeof address>>();
  const started: FakeRuntime[] = [];
  const addressOf = (slug: string) => {
    const found = addresses.get(slug) ?? address(start, started);
    addresses.set(slug, found);
    return found;
  };

  /** A company as `cloud-list` answers it. */
  const listed = (c: FakeCompany): Company => ({
    slug: c.slug,
    name: c.name,
    url: addresses.get(c.slug)?.url ?? `https://${c.slug}.sanoma.work`,
    status: "running",
    ...(c.host && { revision: c.host.revision, healthy: true, ...(c.host.domains && { domains: c.host.domains }) }),
    ...(c.database && { database: { ...c.database, healthy: true } }),
    ...(c.repository && { repository: c.repository }),
  });

  const api = (state: FakeCloudState): CloudApi => ({
    async signup({ slug, name, part, repository, ref, revision, region, domains }) {
      if (!SLUG.test(slug)) throw fail("cloud-signup", `${slug} is not a company's address`);
      if (region && !(REGIONS as readonly string[]).includes(region)) {
        throw fail("cloud-signup", `Sanoma Cloud has no region ${region}`);
      }
      const company = (state.companies[slug] ??= { slug, name });
      if (repository) company.repository = { ...repository, ref: ref ?? "main" };
      if (part === "database") company.database ??= { id: `fake-db-${++state.seq}`, region: region ?? "us-east" };
      else {
        if (!company.repository) throw fail("cloud-signup", "The host needs a repository: pass `repository`");
        const at = revision ?? company.host?.revision ?? "";
        company.host = { revision: at, ...(domains && { domains }) };
        await addressOf(slug).run(slug, at);
      }
      return {
        slug,
        url: addresses.get(slug)?.url ?? `https://${slug}.sanoma.work`,
        ...(company.database && { database: { id: company.database.id } }),
        ...(company.host && { host: { url: addresses.get(slug)?.url, revision: company.host.revision } }),
      };
    },
    list: async ({ slug }) =>
      Object.values(state.companies)
        .filter((c) => slug === undefined || c.slug === slug)
        .map(listed),
    async deploy({ slug, revision }) {
      const company = state.companies[slug];
      if (!company?.host) throw fail("cloud-deploy", `Company "${slug}" has no host: make it with cloud-signup`);
      company.host.revision = revision;
      return { revision, url: await addressOf(slug).run(slug, revision) };
    },
    async close({ slug, part }) {
      const company = state.companies[slug];
      if (!company) throw fail("cloud-close", `Company "${slug}" not found`);
      if (part === "host") {
        delete company.host;
        await addresses.get(slug)?.remove();
      } else delete company.database;
      if (!company.host && !company.database) delete state.companies[slug];
      return {};
    },
  });

  const fake = defineFake(
    cloudOps,
    {
      initial: (): FakeCloudState => ({ seq: 0, companies: {} }),
      ops: (state) => cloudOperations(() => api(state)),
    },
    options,
  );
  const close = async () => {
    for (const found of addresses.values()) await found.close();
    addresses.clear();
  };
  const { reset } = fake;
  return Object.assign(fake, {
    /** Stops the runtime of the host `slug` (default: every one), as a quiet spell would: the next request starts it. */
    async stop(slug?: string) {
      for (const [at, found] of addresses) if (slug === undefined || at === slug) await found.suspend();
    },
    /** Each `/wake` the runtimes answered, in order of their starts. */
    wakes: (): FakeWake[] => started.flatMap((r) => r.wakes ?? []),
    /** Stops every runtime and closes every address. */
    close,
    /** Empties the state and stops everything. */
    async reset() {
      await close();
      reset();
    },
  });
}
