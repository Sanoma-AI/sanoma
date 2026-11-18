import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as forward, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { DriverError, errorMessage, RUNNER_PROTOCOL, runnerScript } from "sanoma/workflows";
import { defineFake, type FakeOptions } from "sanoma/workflows/fake";
import { CLOUD_SLUG, cloudHostnameOf, oneAtATime } from "sanoma/workflows/shared";
import { cloudBackend } from "./backend.ts";
import { REGIONS, cloudOps } from "./connector.ts";
import { BOX_INPUTS, boxProblem, type CloudApi, cloudOperations, type Company } from "./operations.ts";

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
  /**
   * How many boxes Sanoma's account keeps awake at once, for every company: one more is refused as
   * busy (`BOXES_BUSY`), as Agent37's limit is. Default no limit.
   */
  awakeBoxes?: number;
}

/** The company as the fake Cloud keeps it: its id, its address now, its trial, and the parts it has. */
export interface FakeCompany {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  trialEndsAt: string;
  repository?: { owner: string; name: string; ref: string };
  database?: { id: string; region: string };
  host?: { revision: string };
}

/** An agent box of the fake: its instance, whether it is awake, and the hosts it was opened to reach. */
export interface FakeBox {
  id: string;
  awake: boolean;
  hosts: string[];
}

export interface FakeCloudState extends Record<string, unknown> {
  /** Counts up, for ids made in order. */
  seq: number;
  /** The token's company (one token, one company), once there is one, until it is closed. */
  company?: FakeCompany;
  /** The agent boxes, by their name at the Cloud, `<company id>/<name>`. */
  boxes: Record<string, FakeBox>;
  /** Each address a company of the fake took, its own or once its own, by slug: none is ever free again. */
  addresses: Record<string, string>;
  /** Set once the company closed: its token is revoked, and every call with it refused. */
  revoked?: true;
}

/**
 * A company's workflow refusing, as sanoma-ops's do: the run fails, which the api
 * answers 422, and its call with it, in the workflow's own words (`cloudRun`).
 */
const fail = (message: string) => new DriverError(message, { retryable: false, status: 422 });

/** The most boxes a company has at Sanoma Cloud, and the most of them awake at once. */
const BOX_LIMITS = { boxes: 5, awake: 2 } as const;

/** What `cloud-box-open` says when Sanoma's account has every box it may keep awake awake already. */
export const BOXES_BUSY = "All of Sanoma Cloud's agent boxes are busy. Try again in a few minutes.";

/** How long a box's link works: an hour, as the Cloud mints one. */
const LINK_MS = 60 * 60_000;

/**
 * The token's company's box `name`, under its name at the Cloud (`key`, `<company id>/<name>`), and
 * every box of the company's; refused while the token is for no company.
 */
function boxOf(state: FakeCloudState, name: string) {
  const problem = boxProblem(BOX_INPUTS.name, { name });
  if (problem) throw fail(problem);
  if (!state.company) throw fail("This token is for no company");
  const prefix = `${state.company.id}/`;
  const held = Object.entries(state.boxes).filter(([key]) => key.startsWith(prefix));
  return { key: `${prefix}${name}`, box: state.boxes[`${prefix}${name}`], held: held.map(([, box]) => box) };
}

/** A link to `url`, its made-up token in its query as Agent37's is. */
const link = (state: FakeCloudState, url: string) => ({
  url: `${url}/?a37_token=fake-${++state.seq}`,
  expiresAt: new Date(Date.now() + LINK_MS).toISOString(),
});

/** A company of the fake, made now for the token at `slug`, its free trial 7 days, as the Cloud's. */
function newCompany(id: string, slug: string, name = slug): FakeCompany {
  const now = Date.now();
  return {
    id,
    slug,
    name,
    createdAt: new Date(now).toISOString(),
    trialEndsAt: new Date(now + 7 * 86_400_000).toISOString(),
  };
}

/** The token's company `id`, or the workflow's refusal: a token acts on its own company alone. */
function own(state: FakeCloudState, id: string): FakeCompany {
  if (state.company?.id !== id) throw fail(`Company "${id}" not found`);
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

/** How long a runner has to end what it started once told to, in ms, before it is killed. */
const END_MS = 5_000;

/**
 * The fake's boxes on this machine, as Agent37's instances are elsewhere: each box's home a
 * directory of its own under a temporary root, and Sanoma's runner (`runnerScript`) started in it
 * on loopback while it is up, its URL what a link reaches. A sleep keeps the runner, as Agent37's
 * keeps an instance's memory; a discard ends it, and what it started (killed after `END_MS`), and
 * deletes the home. A test process that exits without closing the fake ends its runners and
 * deletes the root on its way out.
 */
function machines() {
  let root: string | undefined;
  const runners = new Map<string, Promise<{ child: ChildProcess; url: string }>>();
  const live = new Set<ChildProcess>();
  const atExit = () => {
    for (const child of live) child.kill("SIGTERM");
    if (root) rmSync(root, { recursive: true, force: true });
  };
  const start = async (id: string) => {
    if (!root) {
      root = mkdtempSync(join(tmpdir(), "sanoma-cloud-boxes-"));
      process.once("exit", atExit);
    }
    const home = join(root, id);
    mkdirSync(home, { recursive: true });
    const script = join(root, "runner.cjs");
    if (!existsSync(script)) writeFileSync(script, await runnerScript());
    const child = spawn(process.execPath, [script], {
      cwd: home,
      env: {
        HOME: home,
        PATH: [dirname(process.execPath), process.env.PATH].join(":"),
        SANOMA_RUNNER_HOST: "127.0.0.1",
        SANOMA_RUNNER_PORT: "0",
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    // A fake no one closes keeps no process of this one up, and ends its runners as it exits (`atExit`).
    live.add(child);
    child.once("exit", () => live.delete(child));
    child.unref();
    (child.stdout as Socket).unref();
    // It says where it listens: `sanoma runner listening on <host>:<port>`.
    const [line] = (await once(createInterface({ input: child.stdout! }), "line")) as [string];
    return { child, url: `http://${line.split(" ").at(-1)}` };
  };
  return {
    /** The runner's URL in the box `id`, started unless it runs. */
    up(id: string) {
      let running = runners.get(id);
      if (!running) {
        running = start(id);
        runners.set(id, running);
        void running.catch(() => runners.delete(id));
      }
      return running.then(({ url }) => url);
    },
    /** Ends the runner in the box `id`, and what it started, and deletes its home. */
    async remove(id: string) {
      const running = runners.get(id);
      runners.delete(id);
      const runner = await running?.then(({ child }) => child).catch(() => undefined);
      if (runner && runner.exitCode === null) {
        const exited = once(runner, "exit");
        runner.kill("SIGTERM");
        const timer = setTimeout(() => runner.kill("SIGKILL"), END_MS);
        await exited.finally(() => clearTimeout(timer));
      }
      if (root) rmSync(join(root, id), { recursive: true, force: true });
    },
    /** Ends every runner and deletes every home. */
    async close() {
      await Promise.all([...runners.keys()].map((id) => this.remove(id)));
      if (root) rmSync(root, { recursive: true, force: true });
      root = undefined;
      process.off("exit", atExit);
    },
  };
}

/**
 * An in-memory Sanoma Cloud for tests: the token's one company in `state.company` (from the start
 * at `slug` when given, else made by the first sign-up by slug), its id `fake-company-<n>`, with
 * the parts `cloud-signup` made (a database `fake-db-<n>` in its region, `us-east` by default; a
 * host at its revision; a repository, `<owner>/<slug>`, in `owner`'s account), every part
 * healthy. `cloud-available` says a slug is the token's when it is or was the open company's
 * address, taken when `taken` names it or a closed company had it, else free; `cloud-invite`
 * answers a made-up link on the host's address. A
 * host runs `start`'s runtime behind an address in this process that outlives it (the stand-in
 * for `<slug>.sanoma.work`, whatever the slug), which starts it on a request, again once it ended
 * on its own (`exited`); a deploy moves it to the new revision and the company to a new slug (the
 * old one stays its own); a close removes the part, a database only once the host is gone, and the
 * last part closes the company and revokes its token. `stop()` stops the host's runtime as
 * the platform may, the address kept; `running()` says whether one runs; `close()` (and `reset()`)
 * stops everything. The company's agent boxes (`cloud-box-*`) are named `<company id>/<name>` and
 * run on this machine (`machines`), each link a loopback URL with a made-up token, the runner of
 * this release's protocol; `sandbox()` is `cloud.sandbox`'s backend over them. It refuses what
 * sanoma-ops's workflows refuse: a slug that is not one or is taken, an id that is not the token's
 * company's, a region the Cloud has not, a host with no repository or database, a deploy of a
 * company with no host, a box past the company's limits (`BOX_LIMITS`) or the account's
 * (`awakeBoxes`, `BOXES_BUSY`), a link to a box there is not, any call once its token is revoked.
 */
export function fakeCloud(options: FakeCloudOptions = {}) {
  const start = options.start ?? stubRuntime;
  let site: ReturnType<typeof address> | undefined;
  const siteOf = () => (site ??= address(start));
  const boxes = machines();

  /** The company as `cloud-list` answers it. */
  const listed = (c: FakeCompany): Company => ({
    id: c.id,
    slug: c.slug,
    name: c.name,
    url: site?.url ?? `https://${cloudHostnameOf(c.slug)}`,
    status: "running",
    createdAt: c.createdAt,
    trialEndsAt: c.trialEndsAt,
    ...(c.host && { revision: c.host.revision }),
    ...(c.database && { database: { ...c.database, healthy: true } }),
    ...(c.repository && { repository: c.repository }),
  });

  const owner = options.owner ?? "sanoma-test";
  const taken = new Set(options.taken);
  /** An address the company `id` takes (a new company's, or a rename's), refused as `cloud-signup` and `cloud-deploy` refuse it. */
  const claim = (state: FakeCloudState, slug: string, id: string) => {
    if (!CLOUD_SLUG.test(slug)) throw fail(`${slug} is not a company's address`);
    const holder = state.addresses[slug];
    if (taken.has(slug) || (holder !== undefined && holder !== id)) {
      throw fail(`${cloudHostnameOf(slug)} is taken: pick another address`);
    }
    state.addresses[slug] = id;
    return slug;
  };

  /** Sanoma Cloud's api with the token: refused once its company closed, as a revoked token is. */
  const api = (state: FakeCloudState): CloudApi => {
    if (state.revoked) {
      throw new DriverError("Sanoma Cloud: the Cloud token is revoked", { retryable: false, status: 401 });
    }
    return workflows(state);
  };

  const workflows = (state: FakeCloudState): CloudApi => ({
    async signup(input) {
      const { part, repository, ref, revision, region } = input;
      if (region && !(REGIONS as readonly string[]).includes(region)) {
        throw fail(`Sanoma Cloud has no region ${region}`);
      }
      let company: FakeCompany;
      if (input.id !== undefined) company = own(state, input.id);
      else if (state.company) {
        // One token, one company: a sign-up by slug names the token's own, or is refused.
        if (state.company.slug !== input.slug) {
          throw fail(`${cloudHostnameOf(input.slug)} is not this token's company`);
        }
        company = state.company;
      } else {
        const id = `fake-company-${++state.seq}`;
        company = state.company = newCompany(id, claim(state, input.slug, id), input.name);
      }
      if (repository) company.repository = { ...repository, ref: ref ?? "main" };
      if (part === "repository") company.repository ??= { owner, name: company.slug, ref: "main" };
      else if (part === "database") company.database ??= { id: `fake-db-${++state.seq}`, region: region ?? "us-east" };
      else {
        if (!company.repository) throw fail("The host needs a repository: pass `repository`");
        if (!company.database) throw fail("The host needs the company's database: make it first");
        const at = revision ?? company.host?.revision ?? "";
        company.host = { revision: at };
        await siteOf().run(at);
      }
      return {};
    },
    list: async ({ id }) =>
      state.company && (id === undefined || id === state.company.id) ? [listed(state.company)] : [],
    async deploy({ id, slug, revision }) {
      const company = own(state, id);
      if (!company.host) throw fail(`Company "${id}" has no host: make it with cloud-signup`);
      if (slug !== company.slug) company.slug = claim(state, slug, id);
      company.host.revision = revision;
      return { id, revision, url: await siteOf().run(revision) };
    },
    available: async ({ slug }) => {
      const holder = state.addresses[slug];
      return {
        available: holder === undefined && !taken.has(slug),
        yours: holder !== undefined && holder === state.company?.id,
      };
    },
    async invite({ id, email }) {
      const company = own(state, id);
      if (!company.host) throw fail(`Company "${id}" has no host to sign in on`);
      return { url: `${listed(company).url}/auth/invite/fake-${++state.seq}-${email}` };
    },
    async close({ id, part }) {
      const company = own(state, id);
      if (part === "host") {
        delete company.host;
        await site?.remove();
      } else {
        if (company.host) {
          throw fail("Close the company's host before deleting its database, or close both together");
        }
        delete company.database;
      }
      // Its last part closes it: its boxes are discarded, its token is revoked, and its addresses stay its own.
      if (!company.host && !company.database) {
        await Promise.all(Object.values(state.boxes).map((box) => boxes.remove(box.id)));
        state.boxes = {};
        delete state.company;
        state.revoked = true;
      }
      return {};
    },
    async boxOpen({ name, hosts }) {
      const problem = boxProblem(BOX_INPUTS.open, { name, hosts });
      if (problem) throw fail(problem);
      const { key, box: found, held } = boxOf(state, name);
      if (!found && held.length >= BOX_LIMITS.boxes) {
        throw fail(
          `This company has ${BOX_LIMITS.boxes} agent boxes already, the most Sanoma Cloud keeps for one company`,
        );
      }
      if (!found?.awake) {
        const awake = Object.values(state.boxes).filter((b) => b.awake).length;
        if (options.awakeBoxes !== undefined && awake >= options.awakeBoxes) throw fail(BOXES_BUSY);
        if (held.filter((b) => b.awake).length >= BOX_LIMITS.awake) {
          throw fail(
            `${BOX_LIMITS.awake} of this company's agent boxes are in use already, the most at once on Sanoma Cloud. Try again when one is done.`,
          );
        }
      }
      const box = (state.boxes[key] ??= { id: `fake-box-${++state.seq}`, awake: false, hosts: [] });
      box.hosts = [...hosts];
      box.awake = true;
      return { id: box.id, ...link(state, await boxes.up(box.id)), protocol: RUNNER_PROTOCOL };
    },
    async boxExpose({ name, port }) {
      const { box } = boxOf(state, name);
      if (!box) throw fail(`There is no agent box ${name}`);
      // The box is this machine: its port is loopback's.
      return link(state, `http://127.0.0.1:${port}`);
    },
    async boxStop({ name }) {
      const { box } = boxOf(state, name);
      if (box) box.awake = false;
      return {};
    },
    async boxDiscard({ name }) {
      const { key, box } = boxOf(state, name);
      if (box) await boxes.remove(box.id);
      delete state.boxes[key];
      return {};
    },
  });

  const fake = defineFake(
    cloudOps,
    {
      initial: (): FakeCloudState => ({
        seq: options.slug ? 1 : 0,
        addresses: options.slug ? { [options.slug]: "fake-company-1" } : {},
        boxes: {},
        ...(options.slug && { company: newCompany("fake-company-1", options.slug) }),
      }),
      ops: (state) => cloudOperations(() => api(state)),
    },
    options,
  );
  const close = async () => {
    await Promise.all([site?.close(), boxes.close()]);
    site = undefined;
  };
  const { reset } = fake;
  return Object.assign(fake, {
    /** `cloud.sandbox`'s backend over the fake's boxes, with the token's company, as `cloud`'s sandbox half opens them. */
    sandbox: () => cloudBackend(api(fake.state)),
    /** Stops the host's runtime, as the Cloud's platform may on its own: the next request starts it. */
    stop: async () => site?.suspend(),
    /** Whether the host's runtime runs (or starts). */
    running: () => site?.running ?? false,
    /** Stops the runtime, closes the address, and ends the boxes. */
    close,
    /** Empties the state and stops everything. */
    async reset() {
      await close();
      reset();
    },
  });
}
