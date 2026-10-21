import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CedarValueJson,
  Clause,
  DetailedError,
  EntityJson,
  Expr,
  PolicyJson,
  SchemaJson,
} from "@cedar-policy/cedar-wasm/nodejs";
import type { Approver, Principal } from "./define.ts";
import {
  approvedFor,
  type Decision,
  type Policy,
  type PolicyCall,
  type PolicyRule,
  type Preview,
  type PreviewRequest,
} from "./policy.ts";
import { cedarWasm, groupNamesOf, NAMESPACE, type PolicyPeople } from "./schema.ts";
import { DATA_VENDOR } from "./shared.ts";

// A company's policies in Cedar (`policies/**/*.cedar`), decided with `@cedar-policy/cedar-wasm`
// against the generated schema (`schema.ts`). Allow is the default: the runtime adds a blanket
// `permit`, so a company's policies are `forbid`s, each a hold when it carries `@hold(...)` and a
// deny otherwise.

/** Where a company's policies are, under its root. */
export const POLICIES_DIR = "policies";

/** One policy: its id (`<file>#<n>`, or its `@id`), its text, and where it is written. */
export interface PolicySource {
  id: string;
  text: string;
  /** Relative to the root, such as `policies/money.cedar`. */
  file?: string;
  /** The line its text starts on in `file`, from 1. */
  line?: number;
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
 * Splits each file into its policies (`policySetTextToParts`), each with its id: its `@id`, else
 * `<file>#<n>` counting from 1. A file that does not parse, a template (`?principal`), and two
 * policies with one id are problems.
 */
export function policiesOf(files: readonly { file: string; text: string }[]): {
  policies: PolicySource[];
  problems: PolicyProblem[];
} {
  const cedar = cedarWasm();
  const policies: PolicySource[] = [];
  const problems: PolicyProblem[] = [];
  for (const { file, text } of files) {
    const parts = cedar.policySetTextToParts(text);
    if (parts.type === "failure") {
      problems.push(...parts.errors.map((e) => problemOf(e, { file, text })));
      continue;
    }
    for (const template of parts.policy_templates) {
      problems.push({
        ...at(text, text.indexOf(template)),
        file,
        message: "a template (`?principal`, `?resource`) is not a policy: name the principal or resource",
      });
    }
    let from = 0;
    parts.policies.forEach((part, n) => {
      const offset = text.indexOf(part, from);
      from = offset + part.length;
      const json = cedar.policyToJson(part);
      const id = (json.type === "success" && json.json.annotations?.id) || `${file}#${n + 1}`;
      if (policies.some((p) => p.id === id) || id === ALLOW_ID) {
        problems.push({ ...at(text, offset), file, message: `two policies have the id "${id}": give one another @id` });
        return;
      }
      policies.push({ id, text: part, file, line: at(text, offset).line });
    });
  }
  return { policies, problems };
}

/** The policies, validated against the schema (`validate`, strict): each error at its policy's file, line and column. */
export function validatePolicies(policies: readonly PolicySource[], schema: SchemaJson<string>): PolicyProblem[] {
  const answer = cedarWasm().validate({
    schema,
    policies: { staticPolicies: Object.fromEntries(policies.map((p) => [p.id, p.text])) },
    validationSettings: { mode: "strict" },
  });
  if (answer.type === "failure") return answer.errors.map((e) => ({ message: messageOf(e) }));
  const order = new Map(policies.map((p, n) => [p.id, n]));
  // In the order the policies are written, each one's from its start.
  return answer.validationErrors
    .map(({ policyId, error }) => {
      const policy = policies[order.get(policyId)!];
      const where = policy?.file === undefined ? {} : { file: policy.file, text: policy.text, at: policy.line ?? 1 };
      return { ...problemOf(error, where), policy: policyId };
    })
    .toSorted(
      (a, b) =>
        order.get(a.policy)! - order.get(b.policy)! ||
        (a.line ?? 0) - (b.line ?? 0) ||
        (a.column ?? 0) - (b.column ?? 0),
    );
}

/** `cedarPolicy`'s input: the policies (`policiesOf`), the generated schema's JSON (`generateSchema`) and the declared people. */
export interface CedarPolicyOptions {
  policies: readonly PolicySource[];
  schema: SchemaJson<string>;
  people: PolicyPeople;
}

/**
 * The policy a repo's Cedar files make, the runtime's `permit` added. Its `version` is a hash of
 * the policies' ids and text. It decides each call with `statefulIsAuthorized` over the policy set
 * and schema parsed once:
 *
 * - allow: `allow`, with the policies that allowed as `reasons`;
 * - a deny one of whose `forbid`s has no `@hold`: `deny` with its `@reason`, or "Refused by <id>";
 * - a deny by `forbid`s with `@hold(x)` only: each lifted once an approval addressed to `x` and
 *   covering the operation is approved (`approvedFor`); allowed when all are, else `approve`,
 *   addressed to the first one's `x`, with its `@title`.
 *
 * `x` is a declared group (`{ group }`), a declared person's id, or `on-behalf-of` (the
 * principal's `onBehalfOf`); one that names no one denies, "cannot resolve approver". A policy that fails to evaluate denies, naming it: Cedar would skip it.
 * Every decision names its policy as `rule`, and its `@title` as `title`.
 */
export function cedarPolicy({ policies, schema, people }: CedarPolicyOptions): Policy {
  const cedar = cedarWasm();
  const rules = policies.map(ruleOf);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const staticPolicies = { ...Object.fromEntries(policies.map((p) => [p.id, p.text])), [ALLOW_ID]: ALLOW };
  const version = createHash("sha256")
    .update(JSON.stringify(Object.entries(staticPolicies)))
    .digest("hex")
    .slice(0, 12);
  // Cedar caches both per thread, by name: the version names this policy's.
  const set = `sanoma-${version}`;
  for (const answer of [cedar.preparsePolicySet(set, { staticPolicies }), cedar.preparseSchema(set, schema)]) {
    if (answer.type === "failure")
      throw new Error(`The Cedar policies do not parse: ${answer.errors.map(messageOf).join("; ")}`);
  }
  const directory = directoryOf(people, schema);

  const isHold = (id: string) => byId.get(id)?.hold !== undefined;

  const decide = (call: PolicyCall): Decision => {
    const principal = directory.principal(call.actor);
    const request = requestOf(directory, principal, call.op.id, call.target, {
      input: call.input,
      ...(call.before !== undefined && { before: call.before }),
      run: { id: call.run.id, workflow: call.run.workflow },
      approverGroups: approverGroupsOf(call, directory),
      approvedBy: approvedByOf(call),
      mount: call.mount ?? "node",
    });
    const answer = cedar.statefulIsAuthorized({
      ...request,
      preparsedSchemaName: set,
      preparsedPolicySetId: set,
      validateRequest: true,
    });
    if (answer.type === "failure") throw new Error(answer.errors.map(messageOf).join("; "));
    const { decision, diagnostics } = answer.response;
    const failed = diagnostics.errors[0];
    if (failed) {
      const rule = byId.get(failed.policyId);
      return {
        kind: "deny",
        reason: `${failed.policyId} failed: ${messageOf(failed.error)}`,
        rule: failed.policyId,
        ...(rule?.title && { title: rule.title }),
      };
    }
    const reasons = diagnostics.reason;
    if (decision === "allow") return { kind: "allow", reasons };
    // In the order they are written, so the first hold asked for is the same every time.
    const forbids = rules.filter((r) => reasons.includes(r.id));
    const refusing = forbids.find((r) => r.hold === undefined);
    if (refusing) return refused(refusing, refusing.reason ?? `Refused by ${refusing.id}`, reasons);
    for (const rule of forbids) {
      const approver = approverOf(rule.hold!, principal, directory);
      if (approver === undefined) return refused(rule, "cannot resolve approver", reasons);
      if (approvedFor(call.run.approvals, call.op.id, approver)) continue;
      return { kind: "approve", approver, rule: rule.id, ...(rule.title !== undefined && { title: rule.title }) };
    }
    return { kind: "allow", reasons, rule: forbids[0]!.id };
  };

  const preview = ({ principal, action, resource, context = {} }: PreviewRequest): Preview => {
    const contextType = contextOf(schema, action);
    const { approverGroups, approvedBy, ...rest } = context;
    const known: Record<string, unknown> = {
      ...rest,
      ...(approverGroups && { approverGroups: approverGroups.map((g) => uid("Group", g)) }),
      ...(approvedBy && { approvedBy: approvedBy.map((id) => uid("Principal", id)) }),
    };
    // Every field not given is unknown, for partial evaluation; one the action does not have is not sent.
    for (const name of Object.keys(contextType?.attributes ?? {})) {
      known[name] ??= UNKNOWN(name);
    }
    const request = requestOf(directory, directory.principal(principal), action, resource, known);
    const answer = cedar.isAuthorizedPartial({
      ...request,
      schema,
      validateRequest: false,
      policies: { staticPolicies },
    });
    if (answer.type === "failure") throw new Error(answer.errors.map(messageOf).join("; "));
    const { decision, mustBeDetermining, nontrivialResiduals, residuals } = answer.response;
    if (decision === "allow") return "allow";
    if (decision === "deny") {
      const forbids = mustBeDetermining.filter((id) => byId.get(id)?.effect === "forbid");
      return forbids.length && forbids.every(isHold) ? "hold" : "deny";
    }
    // Undecided: a residual forbid whose conditions fold to false cannot apply.
    const open = nontrivialResiduals.filter((id) => residuals[id]?.effect === "forbid" && mayApply(residuals[id]!));
    return open.length ? "depends" : "allow";
  };

  return Object.freeze(Object.assign(decide, { version, rules, preview }));
}

/** A policy's rule, as `describeConfig` lists it: its effect and annotations, read with `policyToJson`. */
function ruleOf({ id, text, file }: PolicySource): PolicyRule {
  const answer = cedarWasm().policyToJson(text);
  if (answer.type === "failure")
    throw new Error(`Policy ${id} does not parse: ${answer.errors.map(messageOf).join("; ")}`);
  const { effect, annotations = {} } = answer.json;
  return {
    id,
    ...(file !== undefined && { file }),
    effect,
    ...(annotations.hold !== undefined && { hold: annotations.hold }),
    ...(annotations.title !== undefined && { title: annotations.title }),
    ...(annotations.reason !== undefined && { reason: annotations.reason }),
  };
}

const refused = (rule: PolicyRule, reason: string, reasons: string[]): Decision => ({
  kind: "deny",
  reason,
  reasons,
  rule: rule.id,
  ...(rule.title !== undefined && { title: rule.title }),
});

/** A principal as the policy sees it (C1): its groups and whom it acts for, which the runtime fills from the people. */
type Actor = Principal & { onBehalfOf?: string };

const uid = (type: string, id: string) => ({ type: `${NAMESPACE}::${type}`, id });
const UNKNOWN = (name: string) => ({ __extn: { fn: "unknown", arg: name } });

interface Directory {
  /** The principal with the groups it is a member of and the `onBehalfOf` it is declared with added. */
  principal(actor: Principal): Actor;
  /** The entities of every declared person, and of `actor`, as it is. */
  entities(actor: Actor): EntityJson[];
  /** True for a group the schema has: a declared one, or any when none is declared (the schema then enumerates none). */
  hasGroup(name: string): boolean;
  /** True for a declared group and for a declared person's id: whom a hold may name. */
  isGroup(name: string): boolean;
  isPerson(id: string): boolean;
  /** The declared groups `id` is a member of. */
  groupsOf(id: string): string[];
  schema: SchemaJson<string>;
}

/** The people, as entities: each a `Principal` in its groups, with `onBehalfOf` when it acts for someone. */
function directoryOf(people: PolicyPeople, schema: SchemaJson<string>): Directory {
  const groups = new Set(groupNamesOf(people));
  const declared = new Map(people.people.map((p) => [p.id, p]));
  const hasGroup = (name: string) => !groups.size || groups.has(name);
  const groupsOf = (id: string) => people.groups.filter((g) => g.members.includes(id)).map((g) => g.name);
  const principal = (actor: Principal): Actor => {
    const onBehalfOf = (actor as Actor).onBehalfOf ?? declared.get(actor.id)?.onBehalfOf;
    return {
      ...actor,
      groups: [...new Set([...(actor.groups ?? []), ...groupsOf(actor.id)])],
      ...(onBehalfOf !== undefined && { onBehalfOf }),
    };
  };
  const entityOf = (p: Actor): EntityJson => ({
    uid: uid("Principal", p.id),
    attrs: p.onBehalfOf === undefined ? {} : { onBehalfOf: { __entity: uid("Principal", p.onBehalfOf) } },
    // Only the groups the schema has: it enumerates the declared ones, and Cedar refuses any other.
    parents: (p.groups ?? []).filter(hasGroup).map((g) => uid("Group", g)),
  });
  const everyone = [...declared.keys()].map((id) => entityOf(principal({ id })));
  return {
    principal,
    entities: (actor) => [...everyone.filter((e) => (e.uid as { id: string }).id !== actor.id), entityOf(actor)],
    hasGroup,
    isGroup: (name) => groups.has(name),
    isPerson: (id) => declared.has(id),
    groupsOf,
    schema,
  };
}

/**
 * The request for `action` as `principal`: the resource its kind of action applies to (a
 * workflow, a site, a collection, or an operation's target, in its collection for `data`), and
 * the context shaped to the action's context type (`shape`).
 */
function requestOf(
  directory: Directory,
  principal: Actor,
  action: string,
  target: string | undefined,
  context: Record<string, unknown>,
) {
  const entities = directory.entities(principal);
  const kind = kindOf(action);
  let resource;
  if (kind === undefined) {
    resource = uid("Target", target ?? action);
    const [vendor, collection] = action.split(".");
    const parents = vendor === DATA_VENDOR && collection ? [uid("Collection", collection)] : [];
    entities.push({ uid: resource, attrs: {}, parents });
  } else {
    resource = uid(kind, action.slice(action.indexOf(":") + 1));
  }
  const type = contextOf(directory.schema, action);
  return {
    principal: uid("Principal", principal.id),
    action: uid("Action", action),
    resource,
    context: (type ? shape(context, type) : {}) as Record<string, CedarValueJson>,
    entities,
  };
}

const KINDS: Record<string, string> = { workflow: "Workflow", site: "Site", collection: "Collection" };

/** The entity type `workflow:<name>`, `site:<name>` and `collection:<name>` act on; none for an operation's id. */
const kindOf = (action: string): string | undefined => KINDS[action.split(":", 1)[0]!];

/** A Cedar type, as the generated schema writes them. */
interface CedarType {
  type: string;
  name?: string;
  element?: CedarType;
  attributes?: Record<string, CedarType>;
}

/** The action's context type in the schema, when it is there. */
const contextOf = (schema: SchemaJson<string>, action: string) =>
  schema[NAMESPACE]?.actions[action]?.appliesTo?.context as CedarType | undefined;

/**
 * A value as Cedar takes it for `type`: a record's fields it declares only, a set's elements, a
 * number where it is a `String` as text. An unknown (`{ __extn: unknown }`) and an entity
 * reference pass as they are; what does not fit is left out (undefined), as `null` is.
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
  switch (type.type) {
    case "Set":
      return Array.isArray(value)
        ? value.map((v) => shape(v, type.element!)).filter((v) => v !== undefined)
        : undefined;
    case "Entity":
      return value;
    case "EntityOrCommon":
      if (type.name === "String")
        return typeof value === "string"
          ? value
          : typeof value === "number" || typeof value === "boolean"
            ? String(value)
            : undefined;
      if (type.name === "Long") return Number.isSafeInteger(value) ? value : undefined;
      if (type.name === "Bool") return typeof value === "boolean" ? value : undefined;
      return undefined;
    default:
      return undefined;
  }
}

/**
 * The groups of the approvers of the run's approved approvals that cover the call: a group an
 * approval was addressed to, and the declared groups of whoever decided it.
 */
function approverGroupsOf(call: PolicyCall, directory: Directory) {
  const groups = covering(call).flatMap((a) => [
    ...(typeof a.approver === "string" ? [] : [a.approver.group]),
    ...(a.decidedBy === undefined ? [] : directory.groupsOf(a.decidedBy)),
  ]);
  return [...new Set(groups)].filter(directory.hasGroup).map((g) => uid("Group", g));
}

/** Who decided the run's approved approvals that cover the call. */
const approvedByOf = (call: PolicyCall) =>
  [...new Set(covering(call).flatMap((a) => (a.decidedBy === undefined ? [] : [a.decidedBy])))].map((id) =>
    uid("Principal", id),
  );

const covering = (call: PolicyCall) =>
  call.run.approvals.filter((a) => a.status === "approved" && a.covers.includes(call.op.id));

/** Who a hold is for: `@hold("<group>" | "<person id>" | "on-behalf-of")`, resolved for `principal`. */
function approverOf(hold: string, principal: Actor, directory: Directory): Approver | undefined {
  if (hold === "on-behalf-of") return principal.onBehalfOf;
  if (directory.isGroup(hold)) return { group: hold };
  return directory.isPerson(hold) ? hold : undefined;
}

/** False when one of a residual policy's conditions is already decided against it. */
function mayApply({ conditions }: PolicyJson): boolean {
  return !conditions.some((c: Clause) => folded(c.body) === (c.kind === "unless"));
}

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
    const { left, right } = pair;
    const [l, r] = [folded(left), folded(right)];
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
function problemOf(error: DetailedError, where: { file?: string; text?: string; at?: number }): PolicyProblem {
  const start = error.sourceLocations?.[0]?.start;
  const place =
    where.text !== undefined && start !== undefined
      ? at(where.text, Buffer.from(where.text).subarray(0, start).toString().length, where.at)
      : where.at === undefined
        ? {}
        : { line: where.at };
  return { ...(where.file !== undefined && { file: where.file }), ...place, message: messageOf(error) };
}

/** The line and column of `offset` in `text`, which starts on line `first`. */
function at(text: string, offset: number, first = 1): { line: number; column: number } {
  const before = text.slice(0, Math.max(offset, 0)).split("\n");
  return { line: first + before.length - 1, column: before.at(-1)!.length + 1 };
}
