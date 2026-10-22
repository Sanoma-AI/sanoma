import type { z } from "zod";
import type { Fake } from "./fake.ts";
import type { Secrets } from "./secret.ts";
import type { Steps } from "./steps.ts";

/**
 * What an operation does to the outside world. It sets the badge a reviewer
 * sees and, later, the Cedar action the call is checked against.
 */
export type Effect = "read" | "write" | "publish" | "send" | "money" | "access";

export interface OpSpec<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  effect: Effect;
  input: I;
  output: O;
  /** Safe to retry: the vendor dedupes repeated calls. Otherwise a failed call stops the run. */
  idempotent?: boolean;
  description?: string;
  /**
   * The resource instance a call acts on, from its parsed input, such as a post's id. The
   * policy sees it as `target`, so it can decide per instance. Must be deterministic.
   *
   * Its input is typed `any` inside `defineConnector`: TypeScript gives an inline function the
   * type `Specs` declares, not the one its own spec's schema implies. Annotate it to have it
   * checked: `target: ({ id }: { id: string }) => \`post/${id}\``.
   */
  target?: (input: any) => string;
  /**
   * How a scenario says this operation was set up or called, in Gherkin steps: `given` seeds
   * the fake through it, `expect` expects a call to it. Cucumber expressions whose parameters are
   * fields of the input, such as `{ given: "a post titled {title} exists" }`.
   */
  phrases?: { given?: string; expect?: string };
  /**
   * Top-level fields of its input and output that are the driver's own data, not the vendor's
   * (a resource type's `handle`): the ledger records each as `"<name>"`, never its value.
   */
  opaque?: readonly string[];
}

/** One vendor operation, such as `ghost.post.publish`. Declares the contract only; drivers implement it. */
export interface Op<V extends string = string, R extends string = string, N extends string = string, I = any, O = any> {
  readonly kind: "op";
  readonly id: `${V}.${R}.${N}`;
  readonly vendor: V;
  readonly resource: R;
  readonly name: N;
  readonly effect: Effect;
  readonly idempotent: boolean;
  readonly description?: string;
  /** From the spec: the resource instance a call acts on. */
  readonly target?: (input: any) => string;
  /** From the spec: how a scenario's steps name it. */
  readonly phrases?: { readonly given?: string; readonly expect?: string };
  /** From the spec: fields the ledger records by name only. */
  readonly opaque?: readonly string[];
  readonly input: z.ZodType<any, I>;
  readonly output: z.ZodType<O>;
}

/**
 * Where a resource type keeps its brand. A symbol, so `defineConnector` tells a resource type
 * (`defineResource`) from a group of operations; a registered one (`Symbol.for`), so a copy of
 * this package reads what another copy made, as `VENDOR`.
 */
export const RESOURCE: unique symbol = Symbol.for("sanoma.resource");

/** What `defineConnector` reads of a resource type; `defineResource` makes them. */
export interface ResourceGroup {
  readonly [RESOURCE]: true;
  readonly vendor: string;
  readonly type: string;
  readonly ops: Readonly<Record<string, OpSpec>>;
}

/** A connector's groups: operations by name, or a resource type, whose operations are `read` and `import`. */
export type Specs = Record<string, Record<string, OpSpec> | ResourceGroup>;

/** The operations of one group of `Specs`. */
export type GroupOps<G> = G extends ResourceGroup ? G["ops"] : G;
type InputOf<T> = T extends OpSpec<infer I, any> ? I : never;
type OutputOf<T> = T extends OpSpec<any, infer O> ? O : never;

/**
 * Where a connector keeps its vendor. A symbol, so it names no resource: `Object.values` and
 * `keyof` over a connector see its resources only. A registered one (`Symbol.for`): a process
 * may load two copies of this package (a connector's peer linked into a sanoma checkout, the
 * app's from its tarball), and each must read the connectors the other made.
 */
export const VENDOR: unique symbol = Symbol.for("sanoma.vendor");

export type Connector<V extends string, S extends Specs> = {
  readonly [R in keyof S & string]: {
    readonly [N in keyof GroupOps<S[R]> & string]: Op<
      V,
      R,
      N,
      z.input<InputOf<GroupOps<S[R]>[N]>>,
      z.output<OutputOf<GroupOps<S[R]>[N]>>
    >;
  };
} & { readonly [VENDOR]: ConnectorVendor<V> };

/**
 * The shape of a connector's `[VENDOR]` record. A process may load two builds of this package,
 * and `resolveConfig` reads only a record of its own shape (`checkConnector`): change it with
 * the record, so a build refuses a connector another build made in another shape.
 */
export const CONNECTOR_FORMAT = 1;

/**
 * A connector's vendor: its id, who it is (`defineConnector`'s third argument, for a UI), its
 * resource types, and the driver and fake its package attaches (`withSetup`).
 */
export interface ConnectorVendor<V extends string = string> {
  /** The record's shape (`CONNECTOR_FORMAT`). */
  readonly format: typeof CONNECTOR_FORMAT;
  readonly id: V;
  readonly info?: VendorInfo;
  /** The resource types among its groups, in the order given. */
  readonly resources: readonly ResourceGroup[];
  /** What `withSetup` attached: how the config's resolver makes its driver and its fake. */
  readonly setup?: ConnectorSetup;
}

/**
 * Who a connector's vendor is, and where the connector lives, for a UI to show beside its
 * operations. `logo` is the vendor's mark as inline SVG markup (one `<svg>…</svg>` element), and
 * `dark` its variant for dark backgrounds. The app shows a logo only as an image (a `data:` URL
 * in an `<img>`), where an SVG's scripts and external references never run or load.
 */
export interface VendorInfo {
  /** The vendor's name as it writes it, such as "Resend". */
  title?: string;
  logo?: { svg: string; dark?: string };
  /** The connector's npm package name, such as "@sanoma-ai/connector-resend". */
  package?: string;
  /** The connector package's `homepage` from its package.json: where its code and README are, as an https URL. */
  homepage?: string;
}

/** One `<svg>` element, with nothing but whitespace around it: what a logo must be. */
const SVG_ELEMENT = /^\s*<svg[\s>][\s\S]*<\/svg>\s*$/;

/** Whether `svg` is a logo as `VendorInfo` takes it: one `<svg>…</svg>` element. */
export const isSvgElement = (svg: unknown): svg is string => typeof svg === "string" && SVG_ELEMENT.test(svg);

const isResourceGroup = (group: unknown): group is ResourceGroup =>
  (typeof group === "function" || typeof group === "object") &&
  group !== null &&
  (group as Partial<ResourceGroup>)[RESOURCE] === true;

/**
 * Declares a vendor's operations, grouped by resource: `defineConnector("ghost", { post: { create: {...} } })`.
 * A group may be a resource type from `defineResource`, under its own `type`, for its `read` and
 * `import`: `defineConnector("github", { repository }, { package: "@sanoma-ai/connector-github" })`;
 * it must be of the same vendor, and the connector needs `info.package`, whose `/resources`
 * entry exports the types for data files.
 * `info` says who the vendor is and where the connector lives, for a UI:
 * `{ title: "Resend", logo: { svg }, package: "@sanoma-ai/connector-resend", homepage: "https://…" }`.
 */
export function defineConnector<const V extends string, const S extends Specs>(
  vendor: V,
  specs: S,
  info?: VendorInfo,
): Connector<V, S> {
  // A copy, frozen once checked: changing the caller's object later cannot slip a logo past the check.
  const logo =
    info?.logo && Object.freeze(Object.fromEntries(Object.entries(info.logo).filter(([, v]) => v !== undefined)));
  for (const [variant, svg] of Object.entries(logo ?? {})) {
    if (!isSvgElement(svg)) {
      throw new Error(
        `defineConnector("${vendor}"): logo.${variant} must be inline SVG markup, one <svg>…</svg> element`,
      );
    }
  }
  const vendorInfo = info && Object.freeze({ ...info, ...(logo && { logo: logo as VendorInfo["logo"] }) });
  // It becomes a link's href: a whole https URL, so never a `javascript:` one. Checked on the copy kept.
  const homepage: unknown = vendorInfo?.homepage;
  if (homepage !== undefined && (typeof homepage !== "string" || URL.parse(homepage)?.protocol !== "https:"))
    throw new Error(`defineConnector("${vendor}"): homepage must be an https URL`);
  const out: Record<string, Record<string, Op>> = {};
  const resources: ResourceGroup[] = [];
  for (const [resource, group] of Object.entries(specs)) {
    let ops: Readonly<Record<string, OpSpec>> = group as Record<string, OpSpec>;
    if (isResourceGroup(group)) {
      if (group.vendor !== vendor) {
        throw new Error(`defineConnector("${vendor}"): ${resource} is a resource type of ${group.vendor}`);
      }
      if (group.type !== resource) {
        throw new Error(`defineConnector("${vendor}"): the resource type ${group.type} is given as ${resource}`);
      }
      resources.push(group);
      ops = group.ops;
    }
    out[resource] = {};
    for (const [name, spec] of Object.entries(ops)) {
      out[resource][name] = Object.freeze({
        kind: "op",
        id: `${vendor}.${resource}.${name}`,
        vendor,
        resource,
        name,
        effect: spec.effect,
        idempotent: spec.idempotent ?? false,
        description: spec.description,
        target: spec.target,
        phrases: spec.phrases,
        ...(spec.opaque?.length ? { opaque: spec.opaque } : {}),
        input: spec.input,
        output: spec.output,
      } satisfies Op);
    }
  }
  // A data file imports the resource types from `<package>/resources`, which the reader matches exactly.
  if (resources.length && !vendorInfo?.package) {
    throw new Error(
      `defineConnector("${vendor}"): a connector with resource types needs info.package, the npm package data files import them from (\`<package>/resources\`)`,
    );
  }
  const owner: ConnectorVendor<V> = Object.freeze({
    format: CONNECTOR_FORMAT,
    id: vendor,
    info: vendorInfo,
    resources: Object.freeze(resources),
  });
  return { ...out, [VENDOR]: owner } as unknown as Connector<V, S>;
}

/**
 * What the runtime tells a driver about the call it is making. `idempotencyKey` is the same
 * on every replay and retry of one call (`<runId>:<seq>`), so a driver can hand it to the
 * vendor, or dedupe on it, and a crash between the vendor's reply and the checkpoint does
 * not repeat the side effect.
 */
export interface CallContext {
  idempotencyKey: string;
  runId: string;
  opId: string;
  /** 1 on the first try; retries count up (idempotent operations only). */
  attempt: number;
  /** The secrets store, for the values `secret()` markers name: `resolveSecrets(input, call.secrets)`. In memory for a fake. */
  secrets: Secrets;
  /**
   * Who the call is made as: `run:<runId>` for a call in a run; the person's id for a direct call
   * (`SanomaClient.call`) and in a run of the built-in `call` workflow. A collection's save
   * records it as the record's `updatedBy`.
   */
  by?: string;
}

export type DriverFn<I = any, O = unknown> = (input: I, call: CallContext) => Promise<O>;

/**
 * A vendor's answer that the driver understood. `retryable` tells the runtime whether to try
 * again (an idempotent operation on a timeout or a 5xx) or to stop (a 4xx). `status` and
 * `vendorCode` keep what the vendor said, so the ledger and the UI can show it.
 */
export class DriverError extends Error {
  readonly code = "driver_failed" as const;
  readonly retryable: boolean;
  readonly status?: number;
  readonly vendorCode?: string;

  constructor(message: string, options: { retryable: boolean; status?: number; vendorCode?: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DriverError";
    this.retryable = options.retryable;
    if (options.status !== undefined) this.status = options.status;
    if (options.vendorCode !== undefined) this.vendorCode = options.vendorCode;
  }
}

/**
 * Whether a vendor's HTTP status is worth retrying: a request timeout (408), a rate limit (429)
 * or a server error (5xx). It is the runtime's default rule; a driver adds its vendor's
 * exceptions around it, such as a quota that does not lift in the seconds a retry waits.
 */
export function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * The environment variables a driver reads, as a Zod object of string schemas keyed by variable
 * name, such as `z.object({ ACME_API_KEY: z.string().describe("an API key, from Settings, API keys") })`:
 * each `.describe()` is the variable's one-line manual (what to put there, where to get it),
 * `.optional()` marks one that may be unset. `resolveConfig` checks it against `process.env` and
 * never keeps a value. The driver still reads the raw environment when it is called, so a
 * `.default()` or `.transform()` is not applied to what it reads (use `.optional()` and name the
 * default in `.describe()`), and a `.refine()` or `.superRefine()` on the object is not evaluated,
 * only its fields.
 */
export type DriverEnv = z.ZodObject<Record<string, z.ZodType<string | undefined, string | undefined>>>;

/**
 * Implements a vendor's operations, keyed `"resource.name"`. A driver reads its credentials
 * from the environment when it is called, never from the config file; `env` declares them.
 */
export interface Driver {
  readonly vendor: string;
  readonly ops: Readonly<Record<string, DriverFn>>;
  readonly env?: DriverEnv;
}

/**
 * What a connector package attaches to its connector (`withSetup`), for the config's resolver
 * to call: the config then names the connector alone, and never a driver, a fake, steps or a
 * login. Any may be missing: a workflow using an operation of a connector with no driver is
 * refused, a connector with no fake has none for sandbox runs, and one with no login half signs
 * no visitor in.
 */
export interface ConnectorSetup {
  /** Makes the live driver, which reads its credentials from the environment when called: once per resolved config. */
  driver?: () => Driver;
  /** Makes a fake of the vendor (`defineFake`): once per sandbox run, its own. */
  fake?: () => Fake<any, any>;
  /** The connector's steps for Gherkin tests (`defineSteps`): a config's scenarios and the connector's own features can use them. */
  steps?: Steps;
  /**
   * Makes the connector's login half for one public site: once per site, by the app, when it
   * starts; a login that needs tables migrates them here (serialized, idempotent).
   */
  login?: (context: LoginContext) => LoginHalf | Promise<LoginHalf>;
}

/** What the app gives a connector's login half (`ConnectorSetup.login`) when it makes it for a public site. */
export interface LoginContext {
  /** The company's database (`resolved.databaseUrl`), where a login like Better Auth keeps its users. */
  databaseUrl: string;
  /** Secrets' values by name: the environment's first, then the stored credentials (the values `SanomaClient.secrets` reads). */
  secrets(names: readonly string[]): Promise<Map<string, string>>;
  /**
   * The origins the site answers on, scheme included and `:*` for any port:
   * `["http://www.localhost:*", "https://sanoma.example"]`; a login needs the protocol for its
   * cookies and allowed hosts.
   */
  origins: readonly string[];
}

/**
 * The app sets this header on every request to a public site from the socket's address,
 * overwriting any copy a client sent; a login reads a visitor's address from it (for rate
 * limits), never from `X-Forwarded-For`.
 */
export const CLIENT_IP_HEADER = "x-sanoma-client-ip";

/**
 * A connector's login half: how a public site tells who a visitor is. The app makes one with
 * `login(context)` once per public site, when it starts; a login that keeps tables in the
 * database migrates them itself there, serialized and idempotent. It answers the provider's
 * subject only; the app makes the principal from it (`visitor:<connector>:<subject>`, in
 * `visitors`), so a connector never sets a visitor's groups. A visitor's address, for rate
 * limits, is the `CLIENT_IP_HEADER` header.
 */
export interface LoginHalf {
  /** Who signed in, as the provider's stable subject, or null; never throws for a missing or bad cookie. */
  verify(request: Request): Promise<{ subject: string } | null>;
  /** Answers its own routes, `/auth/<vendor>/*`; undefined for any other request. */
  handle(request: Request): Promise<Response | undefined>;
  /** The path a page POSTs to sign out, which `handle` serves. */
  signOut?: string;
  close?(): Promise<void>;
}

/**
 * The connector with `setup` laid over what it already carries, as a connector package exports
 * it: `export const ghost = withSetup(ghostOps, { driver: ghostDriver, fake: fakeGhost, steps: ghostSteps })`. A
 * config that needs a driver made otherwise (another bridge, other options) swaps that one and
 * keeps the fake: `withSetup(github, { driver: () => githubDriver({ bridge }) })`. The operations
 * are the same objects, and the type is the connector's. The setup is kept on the connector's
 * vendor record (`[VENDOR]`), so a spread copy of the connector keeps it.
 */
export function withSetup<C extends Connector<any, any>>(connector: C, setup: Partial<ConnectorSetup>): C {
  const owner = connector[VENDOR];
  return {
    ...connector,
    [VENDOR]: Object.freeze({ ...owner, setup: Object.freeze({ ...owner.setup, ...setup }) }),
  };
}

/**
 * Throws unless `value` is a connector this package can read: one `defineConnector` made, in this
 * copy of the package or another of the same `CONNECTOR_FORMAT`. One an older build made (its
 * `VENDOR` an unregistered symbol, or its record without a format) is refused as such.
 */
export function checkConnector(value: unknown): asserts value is Connector<any, any> {
  const record =
    typeof value === "object" && value !== null ? (value as Partial<Connector<any, any>>)[VENDOR] : undefined;
  if (record?.format === CONNECTOR_FORMAT) return;
  const build = "install the sanoma packages and connectors from one build";
  throw new Error(
    record === undefined
      ? `\`connectors\` holds something that is not a connector: list what the connector packages export (or one from an older build: ${build})`
      : `The "${String(record.id)}" connector was made by another build of @sanoma-ai/workflows: ${build}`,
  );
}

/** What `withSetup` attached to a connector: nothing when it attached nothing. */
export const setupOf = (connector: Connector<any, any>): ConnectorSetup => connector[VENDOR].setup ?? {};

export function isOp(x: unknown): x is Op {
  return typeof x === "object" && x !== null && (x as Op).kind === "op";
}

/**
 * What a driver for a connector must implement: every operation, by resource and name. Each
 * function gets the input as the operation's schema parses it and returns what its output
 * schema accepts.
 */
export type DriverImpl<S extends Specs> = {
  [R in keyof S & string]: {
    [N in keyof GroupOps<S[R]> & string]: DriverFn<
      z.output<InputOf<GroupOps<S[R]>[N]>>,
      z.input<OutputOf<GroupOps<S[R]>[N]>>
    >;
  };
};

/** The ids of a connector's operations, such as `"ghost.post.create" | "ghost.post.publish"`. */
export type OpIdOf<V extends string, S extends Specs> = {
  [R in keyof S & string]: { [N in keyof GroupOps<S[R]> & string]: `${V}.${R}.${N}` }[keyof GroupOps<S[R]> & string];
}[keyof S & string];

/**
 * Implements a connector's operations, typed by its schemas. A driver must be complete: an
 * operation the connector declares that `impl` leaves out, or one `impl` adds that the
 * connector doesn't declare, is refused here rather than when a run calls it. `options.env`
 * declares the environment variables it reads (see `DriverEnv`).
 */
export function defineDriver<V extends string, S extends Specs>(
  connector: Connector<V, S>,
  impl: DriverImpl<S>,
  options: { env?: DriverEnv } = {},
): Driver {
  const declared = new Map<string, Op>();
  for (const resource of Object.values(connector as Record<string, Record<string, unknown>>)) {
    for (const op of Object.values(resource)) if (isOp(op)) declared.set(`${op.resource}.${op.name}`, op);
  }
  const vendor = connector[VENDOR].id;
  const ops: Record<string, DriverFn> = {};
  const extra: string[] = [];
  for (const [resource, fns] of Object.entries(impl as Record<string, Record<string, unknown>>)) {
    for (const [name, fn] of Object.entries(fns ?? {})) {
      const key = `${resource}.${name}`;
      if (!declared.has(key)) extra.push(`${vendor}.${key}`);
      else if (typeof fn === "function") ops[key] = fn as DriverFn;
    }
  }
  const missing = [...declared.keys()].filter((key) => !Object.hasOwn(ops, key)).map((key) => `${vendor}.${key}`);
  const problems = [
    ...(missing.length ? [`it does not implement ${missing.join(", ")}`] : []),
    ...(extra.length ? [`it implements ${extra.join(", ")}, which the connector does not declare`] : []),
  ];
  if (problems.length) throw new Error(`defineDriver("${vendor}"): ${problems.join("; ")}`);
  return Object.freeze({ vendor, ops: Object.freeze(ops), ...(options.env && { env: options.env }) });
}
