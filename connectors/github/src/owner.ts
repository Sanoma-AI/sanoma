import { type Driver, type DriverFn, DriverError } from "@sanoma-ai/workflows";
import { githubTf } from "./connector.ts";

/**
 * The node ids a binding keeps that the provider cannot import by, by type: a repository's
 * (`R_kgD…`, not `R_` alone, which begins names too, or the legacy base64 of `010:Repository…`,
 * which may hold a `/`) and a branch protection rule's (`BPR_…`). The fake, which has no
 * `resolve`, makes its own (`R_<name>`, `BPR_<repository>:<pattern>`): any of these types' ids
 * without a `/` is one.
 */
const NODE: Readonly<Record<string, RegExp>> = {
  repository: /^(R_kgD[\w-]+|MDEwOlJlcG9zaXRvcnk[\w+/=]+)$/,
  branch_protection: /^BPR_[\w-]+$/,
};
const isNode = (type: string, id: string, live: boolean) =>
  type in NODE && (NODE[type]!.test(id) || (!live && !id.includes("/")));

/** A node id resolved: its repository's owner, and the provider's import id; undefined when GitHub has no such node. */
export type Resolve = (type: string, id: string) => Promise<{ owner: string; id: string } | undefined>;

/**
 * The fields that hold `<owner>/<…>` in a type's shape and the provider's name without its owner:
 * a deploy key's repository and its `<repository>:<key id>`, a team membership's `<team>:<user>`.
 */
const QUALIFIED: Readonly<Record<string, readonly string[]>> = {
  repository_deploy_key: ["id", "repository"],
  team_membership: ["id"],
};
/** The types whose shape has the `owner` field. */
const OWNED = new Set(
  Object.entries(githubTf.resources).flatMap(([type, r]) => ("owner" in r.schema.shape ? [type] : [])),
);

type State = Record<string, unknown>;
interface Input {
  id?: string;
  state?: State;
  desired?: State;
  [key: string]: unknown;
}

/** `<owner>/<rest>` split, or undefined for a name without an owner. */
function split(name: unknown): { owner: string; rest: string } | undefined {
  if (typeof name !== "string") return undefined;
  const at = name.indexOf("/");
  return at > 0 ? { owner: name.slice(0, at), rest: name.slice(at + 1) } : undefined;
}

/**
 * A GitHub driver whose resources name their owner: each call configures the provider for the
 * owner it names (`driverFor(owner)`), from a declaration's `owner` (or its repository's
 * `<owner>/<name>`), a state's, or an id's `<owner>/` prefix, and the provider sees names without
 * it. A node id is resolved by `resolve` first (the live driver's GraphQL query), its owner then
 * the node's; without `resolve` (the fake, which finds an object by its node id itself) it is
 * passed on as it is. A call that names no owner, or two, is refused: GitHub's resources are
 * never read under the token's own user by default. What comes back carries the owner again.
 */
export function owned(driverFor: (owner: string | undefined) => Driver, resolve?: Resolve): Driver {
  const wrapped: Record<string, DriverFn> = {};
  for (const [type, resource] of Object.entries(githubTf.resources)) {
    for (const op of Object.keys(resource.ops)) {
      const key = `${type}.${op}`;
      wrapped[key] = async (input, ctx) => {
        const given = input as Input;
        const sent: Input = { ...given };
        let owner: string | undefined;
        /** Keeps the owner the call names, refusing a second. */
        const note = (named: string) => {
          if (owner === undefined) owner = named;
          else if (owner.toLowerCase() !== named.toLowerCase()) {
            throw refuse(
              `${type}.${op} names two owners, ${owner} and ${named}: a repository moves owner at GitHub, not here`,
            );
          }
        };
        /** `value` without its owner, which is noted; `what` names it in a refusal. */
        const bare = (value: unknown, what: string) => {
          const q = split(value);
          if (!q) throw refuse(`${what} ${String(value)} names no owner: write it <owner>/…`);
          note(q.owner);
          return q.rest;
        };
        for (const part of ["state", "desired"] as const) {
          const value = given[part];
          if (!value) continue;
          if (OWNED.has(type) && typeof value.owner === "string") note(value.owner);
          const out = { ...value };
          for (const field of QUALIFIED[type] ?? []) {
            if (typeof out[field] === "string") out[field] = bare(out[field], `its ${part}'s ${field}`);
          }
          sent[part] = out;
        }
        // A node id passed on as it is: one GitHub does not know, one the provider reads the state
        // that comes with it by (which names the owner, so no lookup), or any given to the fake.
        let node: string | undefined;
        if (given.id !== undefined) {
          if (!isNode(type, given.id, resolve !== undefined)) sent.id = bare(given.id, type);
          else if (owner !== undefined && given.state?.id != null) node = given.id;
          else {
            const found = await resolve?.(type, given.id);
            if (found) {
              note(found.owner);
              sent.id = found.id;
            } else node = given.id;
          }
        }
        if (OWNED.has(type) && given.desired && typeof given.desired.owner !== "string") {
          throw refuse(`${type}.${op}: the declaration names no owner`);
        }
        if (owner === undefined) {
          if (node === undefined) throw refuse(`${type}.${op} names no owner`);
          // A node GitHub does not know, and nothing else naming an owner: gone, with no provider to ask.
          if (resolve) return op === "plan" ? { action: "none", unknown: [], replace: [] } : { id: node, gone: true };
        }
        const out = (await driverFor(owner).ops[key]!(sent, ctx)) as State;
        const result = { ...out };
        if (out.state) {
          result.state = qualify(type, out.state as State, owner);
          // Only a fake's object, put without a `full_name`, and found by its node id, can say none.
          if (OWNED.has(type) && !(result.state as State).owner) {
            throw refuse(`${type} ${given.id ?? ""} has no full_name to tell its owner by`);
          }
        }
        if (out.planned) result.planned = qualify(type, out.planned as State, owner);
        // The id it was given back as given; a new one (a create's, a replace's) with its owner.
        if (typeof out.id === "string") {
          result.id = out.id === sent.id ? given.id : QUALIFIED[type]?.includes("id") ? `${owner}/${out.id}` : out.id;
        }
        return result;
      };
    }
  }
  return Object.freeze({ vendor: githubTf.vendor, ops: Object.freeze(wrapped) });
}

/**
 * A state from the provider with its owner: `owner` set (a repository's from its `full_name`,
 * as GitHub answers it, when it has one) and each qualified field `<owner>/<…>`.
 */
function qualify(type: string, state: State, owner: string | undefined): State {
  const out = { ...state };
  for (const field of QUALIFIED[type] ?? []) {
    if (typeof out[field] === "string" && owner !== undefined) out[field] = `${owner}/${out[field]}`;
  }
  if (OWNED.has(type)) {
    const named = (type === "repository" && split(state.full_name)?.owner) || owner;
    if (named !== undefined) out.owner = named;
  }
  return out;
}

const refuse = (message: string) => new DriverError(`github: ${message}`, { retryable: false });
