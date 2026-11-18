import { createServer, request as forward, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DriverError, errorMessage } from "sanoma/workflows";
import { defineFake, type FakeOptions } from "sanoma/workflows/fake";
import { CLOUD_SLUG, cloudHostnameOf, oneAtATime } from "sanoma/workflows/shared";
import { REGIONS, cloudOps } from "./connector.ts";
import { type CloudApi, cloudOperations, type Company } from "./operations.ts";

/** What `start` runs for a company's host: a runtime answering at `url`, until `stop`. */
export interface FakeRuntime {
  url: string;
  stop(): Promise<void>;
  /** Settles once the runtime ended on its own (its process exited): the host ends with it. */
  exited?: Promise<void>;
}

/** Starts the company's runtime at a revision, as the Cloud's container would, its bootstrap the Cloud's own. */
export type StartRuntime = (input: { revision: string }) => Promise<FakeRuntime>;

export interface FakeCloudOptions extends FakeOptions {
  /** What a host runs. Default: a stub that answers `/healthz` 200 and `/wake` 204. */
  start?: StartRuntime;
  /** The GitHub account the Sanoma.work App makes a company's repository in. Default `sanoma-test`. */
  owner?: string;
  /** Slugs another account holds: `cloud-available` says they are taken, and a sign-up or a rename to one is refused. */
  taken?: readonly string[];
  /**
   * The address (`<slug>.sanoma.work`) of the company the token is for from the start, as a token
   * the wizard minted is: none by default, and a sign-up by slug (`company.repository`) makes it.
   */
  slug?: string;
}

/** The company as the fake Cloud keeps it: its id, its address now, and the parts it has. */
export interface FakeCompany {
  id: string;
  slug: string;
  repository?: { owner: string; name: string; ref: string };
  database?: { id: string; region: string };
  host?: { revision: string };
}

export interface FakeCloudState extends Record<string, unknown> {
  /** Counts up, for ids made in order. */
  seq: number;
  /** The token's company (one token, one company), once there is one. */
  company?: FakeCompany;
}

/** A company's workflow refusing, as sanoma-ops's do: the run fails, which the api answers 422, and its call with it. */
const fail = (workflow: string, message: string) =>
  new DriverError(`Sanoma Cloud: ${workflow}: ${message}`, { retryable: false, status: 422 });

/** The token's company `id`, or the workflow's refusal: a token acts on its own company alone. */
function own(state: FakeCloudState, workflow: string, id: string): FakeCompany {
  if (state.company?.id !== id) throw fail(workflow, `Company "${id}" not found`);
  return state.company;
}

/** A runtime that answers `/healthz` and `/wake`: what a host runs unless the fake is given `start`. */
const stubRuntime: StartRuntime = async () => {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://runtime").pathname;
    if (path === "/healthz") return void res.writeHead(200).end("ok\n");
    res.writeHead(path === "/wake" ? 204 : 404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  server.unref();
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => new Promise<void>((done) => server.close(() => done())),
  };
};

/**
 * The company's address in this process, as `<slug>.sanoma.work` is, whatever its slug: a server
 * made at its first host, kept for the fake's life, that starts the runtime on a request while the
 * host is there (one start at a time, again once the last ended on its own) and forwards the
 * request to it, and answers 404 while there is none.
 */
function address(start: StartRuntime) {
  let revision: string | undefined;
  let runtime: Promise<FakeRuntime> | undefined;
  let server: Server | undefined;
  let url: string | undefined;
  const up = () => {
    if (runtime) return runtime;
    const starting: Promise<FakeRuntime> = start({ revision: revision! }).then(
      (made) => {
        void made.exited?.then(() => {
          if (runtime === starting) runtime = undefined;
        });
        return made;
      },
      (err: unknown) => {
        runtime = undefined;
        throw err;
      },
    );
    return (runtime = starting);
  };
  /** Stops the runtime, the address kept: the next request starts it again. */
  const suspend = async () => {
    const was = runtime;
    runtime = undefined;
    await was?.then(
      (made) => made.stop(),
      () => undefined,
    );
  };
  /** Runs the host at `revision`, now: a new revision stops the runtime that ran the old one. */
  const runAt = async (at: string): Promise<string> => {
    if (revision !== at) await suspend();
    revision = at;
    if (!server) {
      server = createServer((req, res) => {
        if (revision === undefined) return void res.writeHead(404).end("There is nothing here yet\n");
        up().then(
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
    await up();
    return url!;
  };
  // One run after another: the fake does not model how Sanoma Cloud orders two deploys at once.
  const inTurn = oneAtATime();
  return {
    /** Runs the host at `revision`, after any run before it ends (`runAt`). */
    run: (at: string) => inTurn(() => runAt(at)),
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
    /** True while a runtime starts or runs behind it. */
    get running() {
      return runtime !== undefined;
    },
  };
}

/**
 * An in-memory Sanoma Cloud for tests: the token's one company in `state.company` (from the start
 * at `slug` when given, else made by the first sign-up by slug), its id `fake-company-<n>`, with
 * the parts `cloud-signup` made (a database `fake-db-<n>` in its region, `us-east` by default; a
 * host at its revision; a repository, `<owner>/<slug>`, in `owner`'s account), every part
 * healthy. `cloud-available` says a slug is the token's when it is the company's address, taken
 * when `taken` names it, else free; `cloud-invite` answers a made-up link on the host's address. A
 * host runs `start`'s runtime behind an address in this process that outlives it (the stand-in
 * for `<slug>.sanoma.work`, whatever the slug), which starts it on a request, again once it ended
 * on its own (`exited`); a deploy moves it to the new revision and the company to a new slug; a
 * close removes the part, the company staying the token's. `stop()` stops the host's runtime as
 * the platform may, the address kept; `running()` says whether one runs; `close()` (and `reset()`)
 * stops everything. It refuses what sanoma-ops's workflows refuse: a slug that is not one or is
 * taken, an id that is not the token's company's, a region the Cloud has not, a host with no
 * repository, a deploy of a company with no host.
 */
export function fakeCloud(options: FakeCloudOptions = {}) {
  const start = options.start ?? stubRuntime;
  let site: ReturnType<typeof address> | undefined;
  const siteOf = () => (site ??= address(start));

  /** The company as `cloud-list` answers it. */
  const listed = (c: FakeCompany): Company => ({
    id: c.id,
    slug: c.slug,
    url: site?.url ?? `https://${cloudHostnameOf(c.slug)}`,
    status: "running",
    ...(c.host && { revision: c.host.revision, healthy: true }),
    ...(c.database && { database: { ...c.database, healthy: true } }),
    ...(c.repository && { repository: c.repository }),
  });

  const owner = options.owner ?? "sanoma-test";
  const taken = new Set(options.taken);
  /** A new company's address, refused as `cloud-signup` and `cloud-deploy` refuse it. */
  const free = (workflow: string, slug: string) => {
    if (!CLOUD_SLUG.test(slug)) throw fail(workflow, `${slug} is not a company's address`);
    if (taken.has(slug)) throw fail(workflow, `${cloudHostnameOf(slug)} is taken: pick another address`);
    return slug;
  };

  const api = (state: FakeCloudState): CloudApi => ({
    async signup(input) {
      const { part, repository, ref, revision, region } = input;
      if (region && !(REGIONS as readonly string[]).includes(region)) {
        throw fail("cloud-signup", `Sanoma Cloud has no region ${region}`);
      }
      let company: FakeCompany;
      if (input.id !== undefined) company = own(state, "cloud-signup", input.id);
      else if (state.company) {
        // One token, one company: a sign-up by slug names the token's own, or is refused.
        if (state.company.slug !== input.slug) {
          throw fail("cloud-signup", `${cloudHostnameOf(input.slug)} is not this token's company`);
        }
        company = state.company;
      } else company = state.company = { id: `fake-company-${++state.seq}`, slug: free("cloud-signup", input.slug) };
      if (repository) company.repository = { ...repository, ref: ref ?? "main" };
      if (part === "repository") company.repository ??= { owner, name: company.slug, ref: "main" };
      else if (part === "database") company.database ??= { id: `fake-db-${++state.seq}`, region: region ?? "us-east" };
      else {
        if (!company.repository) throw fail("cloud-signup", "The host needs a repository: pass `repository`");
        const at = revision ?? company.host?.revision ?? "";
        company.host = { revision: at };
        await siteOf().run(at);
      }
      return {};
    },
    list: async ({ id }) =>
      state.company && (id === undefined || id === state.company.id) ? [listed(state.company)] : [],
    async deploy({ id, slug, revision }) {
      const company = own(state, "cloud-deploy", id);
      if (!company.host) throw fail("cloud-deploy", `Company "${id}" has no host: make it with cloud-signup`);
      if (slug !== company.slug) company.slug = free("cloud-deploy", slug);
      company.host.revision = revision;
      return { id, revision, url: await siteOf().run(revision) };
    },
    available: async ({ slug }) => {
      const yours = state.company?.slug === slug;
      return { available: !yours && !taken.has(slug), yours };
    },
    async invite({ id, email }) {
      const company = own(state, "cloud-invite", id);
      if (!company.host) throw fail("cloud-invite", `Company "${id}" has no host to sign in on`);
      return { url: `${listed(company).url}/auth/invite/fake-${++state.seq}-${email}` };
    },
    async close({ id, part }) {
      const company = own(state, "cloud-close", id);
      if (part === "host") {
        delete company.host;
        await site?.remove();
      } else delete company.database;
      return {};
    },
  });

  const fake = defineFake(
    cloudOps,
    {
      initial: (): FakeCloudState => ({
        seq: options.slug ? 1 : 0,
        ...(options.slug && { company: { id: "fake-company-1", slug: options.slug } }),
      }),
      ops: (state) => cloudOperations(() => api(state)),
    },
    options,
  );
  const close = async () => {
    await site?.close();
    site = undefined;
  };
  const { reset } = fake;
  return Object.assign(fake, {
    /** Stops the host's runtime, as the Cloud's platform may on its own: the next request starts it. */
    stop: async () => site?.suspend(),
    /** Whether the host's runtime runs (or starts). */
    running: () => site?.running ?? false,
    /** Stops the runtime and closes the address. */
    close,
    /** Empties the state and stops everything. */
    async reset() {
      await close();
      reset();
    },
  });
}
