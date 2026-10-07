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
  readonly input: z.ZodType<any, I>;
  readonly output: z.ZodType<O>;
}

type Specs = Record<string, Record<string, OpSpec>>;

export type Connector<V extends string, S extends Specs> = {
  readonly [R in keyof S & string]: {
    readonly [N in keyof S[R] & string]: Op<V, R, N, z.input<S[R][N]["input"]>, z.output<S[R][N]["output"]>>;
  };
};

/** Declares a vendor's operations, grouped by resource: `defineConnector("ghost", { post: { create: {...} } })`. */
export function defineConnector<const V extends string, const S extends Specs>(vendor: V, specs: S): Connector<V, S> {
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
        input: spec.input,
        output: spec.output,
      } satisfies Op);
    }
  }
  return out as Connector<V, S>;
}

/** Implements a vendor's operations. Credentials live in the driver, never in workflow code. */
export interface Driver {
  vendor: string;
  ops: Record<string, (input: any) => Promise<unknown>>;
}

export function isOp(x: unknown): x is Op {
  return typeof x === "object" && x !== null && (x as Op).kind === "op";
}
