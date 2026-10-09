import type { z } from "zod";

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
  readonly input: z.ZodType<any, I>;
  readonly output: z.ZodType<O>;
}

export type Specs = Record<string, Record<string, OpSpec>>;

/**
 * Where a connector keeps its vendor. A symbol, so it names no resource: `Object.values` and
 * `keyof` over a connector see its resources only.
 */
export const VENDOR: unique symbol = Symbol("sanoma.vendor");

export type Connector<V extends string, S extends Specs> = {
  readonly [R in keyof S & string]: {
    readonly [N in keyof S[R] & string]: Op<V, R, N, z.input<S[R][N]["input"]>, z.output<S[R][N]["output"]>>;
  };
} & { readonly [VENDOR]: ConnectorVendor<V> };

/** A connector's vendor: its id and, from `defineConnector`'s third argument, who it is, for a UI. */
export interface ConnectorVendor<V extends string = string> {
  readonly id: V;
  readonly info?: VendorInfo;
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
  /** The connector's npm package name, such as "@sanoma/connector-resend". */
  package?: string;
  /** The connector package's `homepage` from its package.json: where its code and README are, as an https URL. */
  homepage?: string;
}

/** One `<svg>` element, with nothing but whitespace around it. */
const SVG_ELEMENT = /^\s*<svg[\s>][\s\S]*<\/svg>\s*$/;

/**
 * Declares a vendor's operations, grouped by resource: `defineConnector("ghost", { post: { create: {...} } })`.
 * `info` says who the vendor is and where the connector lives, for a UI:
 * `{ title: "Resend", logo: { svg }, package: "@sanoma/connector-resend", homepage: "https://…" }`.
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
    if (typeof svg !== "string" || !SVG_ELEMENT.test(svg)) {
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
  for (const [resource, ops] of Object.entries(specs)) {
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
        input: spec.input,
        output: spec.output,
      } satisfies Op);
    }
  }
  const owner: ConnectorVendor<V> = Object.freeze({ id: vendor, info: vendorInfo });
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
 * Implements a vendor's operations, keyed `"resource.name"`. A driver reads its credentials
 * when it is called (from the environment or a secret store), never from the config file.
 */
export interface Driver {
  vendor: string;
  ops: Record<string, DriverFn>;
}

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
    [N in keyof S[R] & string]: DriverFn<z.output<S[R][N]["input"]>, z.input<S[R][N]["output"]>>;
  };
};

/** The ids of a connector's operations, such as `"ghost.post.create" | "ghost.post.publish"`. */
export type OpIdOf<V extends string, S extends Specs> = {
  [R in keyof S & string]: { [N in keyof S[R] & string]: `${V}.${R}.${N}` }[keyof S[R] & string];
}[keyof S & string];

/**
 * Implements a connector's operations, typed by its schemas. A driver must be complete: an
 * operation the connector declares that `impl` leaves out, or one `impl` adds that the
 * connector doesn't declare, is refused here rather than when a run calls it.
 */
export function defineDriver<V extends string, S extends Specs>(
  connector: Connector<V, S>,
  impl: DriverImpl<S>,
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
  return { vendor, ops };
}
