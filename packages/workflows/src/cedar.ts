import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CedarValueJson, DetailedError, EntityJson, Expr, PolicyJson } from "@cedar-policy/cedar-wasm/nodejs";
import type { ResolvedConfig } from "./config.ts";
import type { Approver, Principal } from "./define.ts";
import {
  approvedFor,
  type Decision,
  type Policy,
  type PolicyCall,
  type PreviewAnswer,
  type PreviewRequest,
} from "./policy.ts";
import { AGENTS, type CedarSchemaJson, cedarWasm, NAMESPACE, type PolicyPeople, schemaOf } from "./schema.ts";
import { approverLabel, DATA_VENDOR } from "./shared.ts";

// A company's policies in Cedar (`policies/**/*.cedar`), decided with `@cedar-policy/cedar-wasm`
// against the schema of its resolved config (`schemaOf`). Allow is the default: the runtime adds
// the one `permit`, so a company's policies are `forbid`s, each a hold when it carries
// `@hold(...)` and a deny otherwise.

/** Where a company's policies are, under its root. */
export const POLICIES_DIR = "policies";

/** One policy, as loaded: its id, its text and where it is written, and the annotations Sanoma reads. */
export interface CedarPolicySource {
  /** Its `@id`, else `<file>#<n>`, counting from 1 in the order written. */
  id: string;
  text: string;
  /** Relative to the root, such as `policies/money.cedar`. */
  file: string;
  /** The line its text starts on in `file`, from 1. */
  line: number;
  effect: "permit" | "forbid";
  /** `@hold(...)`: a declared group, a declared person's id, or `on-behalf-of`. */
  hold?: string;
  /** `@title(...)`: the Inbox title of its hold. */
  title?: string;
  /** `@reason(...)`: the message of its deny. */
  reason?: string;
}

/** What is wrong in the policies, at a file, line and column when Cedar says where. */
export interface PolicyProblem {
  file?: string;
  line?: number;
  column?: number;
  /** The policy's id, when the problem is in one. */
  policy?: string;
  message: string;
}

/** The runtime's own policy: allow whatever no `forbid` refuses. */
const ALLOW_ID = "allow-by-default";
const ALLOW = "permit (principal, action, resource);";

/** `<root>/policies/**\/*.cedar`, sorted by path, each relative to the root with `/` between its parts. */
export function readPolicyFiles(root: string): { file: string; text: string }[] {
  return globSync(`${POLICIES_DIR}/**/*.cedar`, { cwd: root })
    .map((file) => file.split("\\").join("/"))
    .toSorted()
    .map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
}

/**
 * Each file's policies, in the order written (`policySetTextToParts`, which sorts them, then
 * their places in the text), each with its id and annotations (`policyToJson`): built once, the
 * map from a policy's id to what decides its answer. A file that does not parse, a template and
 * two policies with one id are problems.
 */
export function loadPolicies(files: readonly { file: string; text: string }[]): {
  policies: CedarPolicySource[];
  problems: PolicyProblem[];
} {
  const cedar = cedarWasm();
  const policies: CedarPolicySource[] = [];
  const problems: PolicyProblem[] = [];
  for (const { file, text } of files) {
    const parts = cedar.policySetTextToParts(text);
    if (parts.type === "failure") {
      problems.push(...parts.errors.map((e) => problemOf(e, { file, text })));
      continue;
    }
    for (const template of parts.policy_templates) {
      problems.push({
        file,
        ...at(text, text.indexOf(template)),
        message: "a template (`?principal`, `?resource`) is not a policy: name the principal or resource",
      });
    }
    const placed = new Set<number>();
    const inOrder = parts.policies
      .map((part) => {
        let offset = text.indexOf(part);
        while (placed.has(offset)) offset = text.indexOf(part, offset + 1);
        placed.add(offset);
        return { part, offset };
      })
      .toSorted((a, b) => a.offset - b.offset);
    inOrder.forEach(({ part, offset }, n) => {
      const answer = cedar.policyToJson(part);
      if (answer.type === "failure") {
        problems.push(...answer.errors.map((e) => problemOf(e, { file, text: part, at: at(text, offset).line })));
        return;
      }
      const { effect, annotations = {} } = answer.json;
      const id = annotations.id ?? `${file}#${n + 1}`;
      const line = at(text, offset).line;
      if (id === ALLOW_ID || policies.some((p) => p.id === id)) {
        const why = id === ALLOW_ID ? "is the runtime's own policy's" : "is another policy's";
        problems.push({ file, line, column: 1, message: `the id "${id}" ${why}: give this one another @id` });
        return;
      }
      policies.push({
        id,
        text: part,
        file,
        line,
        effect,
        ...(annotations.hold !== undefined && { hold: annotations.hold }),
        ...(annotations.title !== undefined && { title: annotations.title }),
        ...(annotations.reason !== undefined && { reason: annotations.reason }),
      });
    });
  }
  return { policies, problems };
}

/**
 * The policies checked against the schema of the resolved config (`validate`, strict), and what
 * Cedar cannot check: a `permit` (the runtime's is the only one), and a `@hold` naming neither a
 * declared group, nor a declared person, nor `on-behalf-of`. In the order written, each at its
 * file, line and column.
 */
export function validatePolicies(
  resolved: Pick<ResolvedConfig, "ops" | "workflows" | "collections">,
  policies: readonly CedarPolicySource[],
  people: PolicyPeople,
): PolicyProblem[] {
  const answer = cedarWasm().validate({
    schema: schemaOf(resolved, people),
    policies: { staticPolicies: Object.fromEntries(policies.map((p) => [p.id, p.text])) },
    validationSettings: { mode: "strict" },
  });
  if (answer.type === "failure") return answer.errors.map((e) => ({ message: messageOf(e) }));
  const byId = new Map(policies.map((p) => [p.id, p]));
  const cedar = answer.validationErrors.map(({ policyId, error }) => {
    const p = byId.get(policyId)!;
    return { ...problemOf(error, { file: p.file, text: p.text, at: p.line }), policy: policyId };
  });
  const ours = policies.flatMap((p): PolicyProblem[] => {
    const place = { file: p.file, line: p.line, column: 1, policy: p.id };
    if (p.effect === "permit") {
      return [{ ...place, message: "a permit changes nothing: every call no forbid refuses is allowed already" }];
    }
    if (p.hold !== undefined && p.hold !== ON_BEHALF_OF && approverOf(p.hold, people) === undefined) {
      return [{ ...place, message: `@hold("${p.hold}") names no declared group or person, nor "${ON_BEHALF_OF}"` }];
    }
    return [];
  });
  const order = new Map(policies.map((p, n) => [p.id, n]));
  return [...cedar, ...ours].toSorted(
    (a, b) =>
      order.get(a.policy!)! - order.get(b.policy!)! ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0),
  );
}

/** The `@hold` that addresses the principal's `onBehalfOf`. */
const ON_BEHALF_OF = "on-behalf-of";

/**
 * The policy a repo's Cedar files make, the runtime's `permit` added; `kind` is `cedar`, and its
 * `version` a hash of the policies' ids and text. It decides each call with `statefulIsAuthorized`
 * over the policy set and the schema of `resolved` (`schemaOf`), each parsed once:
 *
 * - allow: `allow`, with the policies that allowed as `reasons`;
 * - deny, a determining `forbid` without `@hold`: `deny` with its `@reason`, or "Refused by <id>";
 * - deny by `@hold` forbids only: each lifted once an approval addressed to its approver and
 *   covering the operation is approved (`approvedFor`); allowed when all are, else `approve` for
 *   the first, in the order written, with its `@title`.
 *
 * An approver is a declared group (`{ group }`), a declared person's id, or the principal's
 * `onBehalfOf`; a principal acting for no one makes `on-behalf-of` a deny, "cannot resolve
 * approver". A policy that fails to evaluate is a deny naming it (Cedar would skip it).
 * `preview` asks the same ahead of a call, its context unknown.
 */
export function cedarPolicy(
  resolved: Pick<ResolvedConfig, "ops" | "workflows" | "collections">,
  policies: readonly CedarPolicySource[],
  people: PolicyPeople,
): Policy {
  const cedar = cedarWasm();
  const schema = schemaOf(resolved, people);
  const staticPolicies = { ...Object.fromEntries(policies.map((p) => [p.id, p.text])), [ALLOW_ID]: ALLOW };
  const version = hash(staticPolicies);
  // Cedar caches both per thread, by name: one for these policies over this schema.
  const set = `sanoma-${hash({ staticPolicies, schema })}`;
  for (const answer of [cedar.preparsePolicySet(set, { staticPolicies }), cedar.preparseSchema(set, schema)]) {
    if (answer.type === "failure")
      throw new Error(`The Cedar policies do not parse: ${answer.errors.map(messageOf).join("; ")}`);
  }
  const directory = directoryOf(people);

  const decide = (call: PolicyCall): Decision => {
    const principal = directory.principal(call.actor);
    const answer = cedar.statefulIsAuthorized({
      ...requestOf(schema, directory, principal, call.op.id, call.target, {
        input: call.input,
        ...(call.before !== undefined && { before: call.before }),
      }),
      preparsedSchemaName: set,
      preparsedPolicySetId: set,
      validateRequest: true,
    });
    if (answer.type === "failure") throw new Error(answer.errors.map(messageOf).join("; "));
    const { decision, diagnostics } = answer.response;
    const failed = diagnostics.errors[0];
    if (failed)
      return {
        kind: "deny",
        reason: `${failed.policyId} failed: ${messageOf(failed.error)}`,
        reasons: [failed.policyId],
      };
    const reasons = diagnostics.reason;
    if (decision === "allow") return { kind: "allow", reasons };
    // In the order written, so the first hold asked for is the same every time.
    const forbids = policies.filter((p) => reasons.includes(p.id));
    const refusing = forbids.find((p) => p.hold === undefined);
    if (refusing) return { kind: "deny", reason: refusing.reason ?? `Refused by ${refusing.id}`, reasons };
    for (const p of forbids) {
      const approver = holdOf(p, principal, directory);
      if (approver === undefined) return { kind: "deny", reason: "cannot resolve approver", reasons };
      if (approvedFor(call.run.approvals, call.op.id, approver)) continue;
      return { kind: "approve", approver, title: p.title ?? `${call.op.id} needs ${approverLabel(approver)}` };
    }
    return { kind: "allow", reasons };
  };

  const preview = (requests: readonly PreviewRequest[]): PreviewAnswer[] =>
    requests.map(({ principal: actor, action, resource }) => {
      const principal = directory.principal(actor);
      // Every field of the context is unknown: partial evaluation leaves what depends on it.
      const unknown = Object.fromEntries(
        Object.keys(contextOf(schema, action.id)?.attributes ?? {}).map((name) => [name, UNKNOWN(name)]),
      );
      const request = requestOf(schema, directory, principal, action.id, resource, unknown);
      const answer = cedar.isAuthorizedPartial({
        ...request,
        schema,
        validateRequest: false,
        policies: { staticPolicies },
      });
      if (answer.type === "failure") throw new Error(answer.errors.map(messageOf).join("; "));
      const { decision, mustBeDetermining, nontrivialResiduals, residuals } = answer.response;
      if (decision === "allow") return { answer: "allow" };
      if (decision === "deny") {
        const forbids = policies.filter((p) => mustBeDetermining.includes(p.id));
        const refusing =
          forbids.find((p) => p.hold === undefined) ?? forbids.find((p) => !holdOf(p, principal, directory));
        if (refusing || !forbids.length) return { answer: "deny", ...(refusing && { rule: ruleOf(refusing) }) };
        return { answer: "hold", rule: ruleOf(forbids[0]!), approver: holdOf(forbids[0]!, principal, directory)! };
      }
      // Undecided: a residual forbid whose conditions fold to false cannot apply.
      const open = policies.find((p) => nontrivialResiduals.includes(p.id) && mayApply(residuals[p.id]!));
      return open ? { answer: "depends", rule: ruleOf(open) } : { answer: "allow" };
    });

  return Object.freeze(Object.assign(decide, { kind: "cedar" as const, version, preview }));
}

/** A policy as a preview names it. */
const ruleOf = (p: CedarPolicySource) => ({
  id: p.id,
  file: p.file,
  ...(p.title !== undefined && { title: p.title }),
  ...(p.reason !== undefined && { reason: p.reason }),
});

/** The first 12 hex digits of a SHA-256 of `value` as JSON. */
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

/** A principal as the policy sees it: its groups and whom it acts for. */
type Actor = Principal & { onBehalfOf?: string };

const uid = (type: string, id: string) => ({ type: `${NAMESPACE}::${type}`, id });
const UNKNOWN = (name: string) => ({ __extn: { fn: "unknown", arg: name } });

// Stand-ins for P1's `principalOf(id, resources)` and `approverOf(name, resources)` in
// `shared.ts` (#197), with their signatures: replaced by those once they land.

/** The declared principal `id`, with the groups it is a member of (an agent's among them, `agents`), or undefined. */
function principalOf(id: string, resources: PolicyPeople): Actor | undefined {
  const declared = resources.people.find((p) => p.id === id);
  if (!declared) return undefined;
  const groups = resources.groups.filter((g) => g.members.includes(id)).map((g) => g.name);
  return { id, groups, ...(declared.onBehalfOf !== undefined && { onBehalfOf: declared.onBehalfOf }) };
}

/** Who `name` addresses as an approver: a declared group (`agents` among them), else a declared person, else undefined. */
function approverOf(name: string, resources: PolicyPeople): Approver | undefined {
  if (name === AGENTS || resources.groups.some((g) => g.name === name)) return { group: name };
  return resources.people.some((p) => p.id === name) ? name : undefined;
}

interface Directory {
  /** The principal with the groups and `onBehalfOf` it is declared with added. */
  principal(actor: Principal): Actor;
  /** The entities of every declared principal, and of `actor`, as it is. */
  entities(actor: Actor): EntityJson[];
  approver(name: string): Approver | undefined;
}

/** The people as Cedar entities: each a `Principal` in its groups, with `onBehalfOf` when it acts for someone. */
function directoryOf(people: PolicyPeople): Directory {
  const groups = new Set([...people.groups.map((g) => g.name), AGENTS]);
  const principal = (actor: Principal): Actor => {
    const declared = principalOf(actor.id, people);
    const onBehalfOf = (actor as Actor).onBehalfOf ?? declared?.onBehalfOf;
    return {
      ...actor,
      groups: [...new Set([...(actor.groups ?? []), ...(declared?.groups ?? [])])],
      ...(onBehalfOf !== undefined && { onBehalfOf }),
    };
  };
  const entityOf = (p: Actor): EntityJson => ({
    uid: uid("Principal", p.id),
    attrs: p.onBehalfOf === undefined ? {} : { onBehalfOf: { __entity: uid("Principal", p.onBehalfOf) } },
    // Only the groups the schema enumerates: Cedar refuses any other.
    parents: (p.groups ?? []).filter((g) => groups.has(g)).map((g) => uid("Group", g)),
  });
  const everyone = people.people.map((p) => entityOf(principal({ id: p.id })));
  return {
    principal,
    entities: (actor) => [...everyone.filter((e) => (e.uid as { id: string }).id !== actor.id), entityOf(actor)],
    approver: (name) => approverOf(name, people),
  };
}

/** Whom a `@hold` policy holds the call for, resolved for `principal`: undefined when it names no one. */
const holdOf = (p: CedarPolicySource, principal: Actor, directory: Directory): Approver | undefined =>
  p.hold === ON_BEHALF_OF ? principal.onBehalfOf : directory.approver(p.hold!);

/**
 * The request for `action` as `principal`: a workflow start on its `Workflow`, an operation on
 * its target (the operation's id when it has none), in its collection for `data`; the context
 * shaped to the action's context type (`shape`).
 */
function requestOf(
  schema: CedarSchemaJson,
  directory: Directory,
  principal: Actor,
  action: string,
  target: string | undefined,
  context: Record<string, unknown>,
) {
  const entities = directory.entities(principal);
  let resource;
  if (action.startsWith("workflow:")) {
    resource = uid("Workflow", action.slice("workflow:".length));
  } else {
    resource = uid("Target", target ?? action);
    const [vendor, collection] = action.split(".");
    const parents = vendor === DATA_VENDOR && collection ? [uid("Collection", collection)] : [];
    entities.push({ uid: resource, attrs: {}, parents });
  }
  const type = contextOf(schema, action);
  return {
    principal: uid("Principal", principal.id),
    action: uid("Action", action),
    resource,
    context: (type ? shape(context, type) : {}) as Record<string, CedarValueJson>,
    entities,
  };
}

/** A Cedar type, as `schemaOf` writes them. */
interface CedarType {
  type: string;
  name?: string;
  element?: CedarType;
  attributes?: Record<string, CedarType>;
}

/** The action's context type in the schema, when it is there. */
const contextOf = (schema: CedarSchemaJson, action: string) =>
  schema[NAMESPACE]?.actions[action]?.appliesTo?.context as CedarType | undefined;

/**
 * A value as Cedar takes it for `type`: a record's fields it declares only, a set's elements, a
 * number where it is a `String` as text. An unknown (`{ __extn: unknown }`) passes as it is; what
 * does not fit is left out (undefined), as `null` is.
 */
function shape(value: unknown, type: CedarType): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "object" && "__extn" in value) return value;
  if (type.attributes) {
    if (typeof value !== "object" || Array.isArray(value)) return undefined;
    const fields = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(type.attributes).flatMap(([name, t]) => {
        const shaped = shape(fields[name], t);
        return shaped === undefined ? [] : [[name, shaped]];
      }),
    );
  }
  if (type.type === "Set") {
    return Array.isArray(value) ? value.map((v) => shape(v, type.element!)).filter((v) => v !== undefined) : undefined;
  }
  switch (type.name) {
    case "String":
      return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
    case "Long":
      return Number.isSafeInteger(value) ? value : undefined;
    case "Bool":
      return typeof value === "boolean" ? value : undefined;
    default:
      return undefined;
  }
}

/** False when one of a residual policy's conditions is already decided against it. */
const mayApply = ({ conditions }: PolicyJson): boolean =>
  !conditions.some((c) => folded(c.body) === (c.kind === "unless"));

type Pair = { left: Expr; right: Expr };

/** A residual's value when its constants decide it, else undefined: partial evaluation leaves `unknown && false` as it is. */
function folded(expr: Expr): boolean | undefined {
  const e = expr as {
    Value?: unknown;
    "!"?: { arg: Expr };
    "&&"?: Pair;
    "||"?: Pair;
    "if-then-else"?: { if: Expr; then: Expr; else: Expr };
  };
  if ("Value" in e) return typeof e.Value === "boolean" ? e.Value : undefined;
  if (e["!"]) {
    const arg = folded(e["!"].arg);
    return arg === undefined ? undefined : !arg;
  }
  const pair = e["&&"] ?? e["||"];
  if (pair) {
    const and = e["&&"] !== undefined;
    const [l, r] = [folded(pair.left), folded(pair.right)];
    // `and`: false decides it, true twice makes it; `or`: the other way round.
    if (l === !and || r === !and) return !and;
    return l === and && r === and ? and : undefined;
  }
  if (e["if-then-else"]) {
    const { if: test, then, else: otherwise } = e["if-then-else"];
    const t = folded(test);
    return t === undefined ? undefined : folded(t ? then : otherwise);
  }
  return undefined;
}

/** Cedar's message, with its help when it has one. */
const messageOf = (e: DetailedError) => (e.help ? `${e.message} (${e.help})` : e.message);

/** A Cedar error as a problem at its place in `text`, which starts on line `at` of `file`. */
function problemOf(error: DetailedError, where: { file: string; text: string; at?: number }): PolicyProblem {
  const start = error.sourceLocations?.[0]?.start;
  // Cedar counts bytes; a line and column count characters.
  const place =
    start === undefined
      ? { line: where.at ?? 1 }
      : at(where.text, Buffer.from(where.text).subarray(0, start).toString().length, where.at);
  return { file: where.file, ...place, message: messageOf(error) };
}

/** The line and column of `offset` in `text`, which starts on line `first`. */
function at(text: string, offset: number, first = 1): { line: number; column: number } {
  const before = text.slice(0, Math.max(offset, 0)).split("\n");
  return { line: first + before.length - 1, column: before.at(-1)!.length + 1 };
}
