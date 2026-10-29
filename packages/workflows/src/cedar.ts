import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import type { CedarValueJson, DetailedError, EntityJson, Expr, PolicyJson } from "@cedar-policy/cedar-wasm/nodejs";
import { locator } from "./ast.ts";
import type { ResolvedConfig } from "./config.ts";
import type { ApprovalState, Approver, Principal } from "./define.ts";
import { filesUnder, kindDirs } from "./paths.ts";
import {
  allow,
  allowAll,
  approve,
  approvedFor,
  type Decision,
  deny,
  denyAll,
  type Policy,
  type PolicyCall,
  type PreviewAnswer,
  type PreviewRequest,
  VISITOR_DENIED,
} from "./policy.ts";
import { admit, readPeople } from "./resources.ts";
import { cedarValue, cedarWasm, contextTypeOf, messageOf, NAMESPACE, schemaOf, shapeOf } from "./schema.ts";
import {
  ANONYMOUS,
  approverLabel,
  approverOf,
  CALL_WORKFLOW,
  DATA_VENDOR,
  groupNamesOf,
  isVisitor,
  type PeopleResource,
  principalIdsOf,
  principalOf,
  problemLine,
  VISITORS,
  WORKFLOW_ACTION,
} from "./shared.ts";

// A company's policies in Cedar (`policies/**/*.cedar`), decided with `@cedar-policy/cedar-wasm`
// against the schema of its resolved config (`schemaOf`). Allow is the default: the runtime adds
// the one `permit` for people and agents, so a company's policies are `forbid`s, each a hold when
// it carries `@hold(...)` and a deny otherwise, and the `permit`s that let visitors in.

/** Where a company's policies are, under its root. */
export const POLICIES_DIR = "policies";

/** One policy, as loaded: its id, its text and where it is written, and the annotations Sanoma reads. */
export interface CedarPolicySource {
  /** Its `@id`, else `<file>#<n>`, counting from 1 in the order written. */
  id: string;
  text: string;
  /** Relative to the root, such as `policies/money.cedar`. */
  file: string;
  /** The line and column its text starts at in `file`, from 1. */
  line: number;
  column: number;
  effect: "permit" | "forbid";
  /** `@hold(...)`: a declared group, a declared person's id, or `on-behalf-of`. */
  hold?: string;
  /** `@title(...)`: the Inbox title of its hold. */
  title?: string;
  /** `@reason(...)`: the message of its deny. */
  reason?: string;
  /** Whom a `permit` is for, when its principal is exactly `in Sanoma::Group::"visitors"` or `== Sanoma::Principal::"anonymous"`. */
  scope?: typeof VISITORS | typeof ANONYMOUS;
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

/**
 * The runtime's own policy: allow whatever no `forbid` refuses. A visitor's start or direct call
 * is asked of the company's permits first (`cedarPolicy`): the runtime's permit leaves visitors out there.
 */
const ALLOW_ID = "allow-by-default";
const ALLOW = "permit (principal, action, resource);";

/** The `@hold` that addresses the principal's `onBehalfOf`. */
const ON_BEHALF_OF = "on-behalf-of";

type Place = { line: number; column: number };

/** `<root>/policies/**\/*.cedar`, then each app's `apps/<app>/policies/**\/*.cedar`, sorted by path in each, each relative to the root with `/` between its parts. */
export function readPolicyFiles(root: string): { file: string; text: string }[] {
  return kindDirs(root, POLICIES_DIR)
    .flatMap((dir) => filesUnder(dir, (name) => name.endsWith(".cedar")))
    .map((path) => ({
      file: relative(root, path).split(sep).join("/"),
      text: readFileSync(path, "utf8"),
    }));
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
  const ids = new Set([ALLOW_ID]);
  for (const { file, text } of files) {
    const locate = locator(text);
    const parts = cedar.policySetTextToParts(text);
    if (parts.type === "failure") {
      problems.push(...parts.errors.map((e) => problemOf(e, file, text)));
      continue;
    }
    for (const template of parts.policy_templates) {
      problems.push({
        file,
        ...locate(text.indexOf(template)),
        message: "a template (`?principal`, `?resource`) is not a policy: name the principal or resource",
      });
    }
    const placed = new Set<number>();
    const inOrder = parts.policies
      .map((part) => {
        let offset = text.indexOf(part);
        while (offset >= 0 && placed.has(offset)) offset = text.indexOf(part, offset + 1);
        placed.add(offset);
        // A part that is not a slice of the text (none is, as Cedar 4.14 cuts them) keeps Cedar's order, last.
        return { part, offset: offset < 0 ? Infinity : offset };
      })
      .toSorted((a, b) => a.offset - b.offset);
    inOrder.forEach(({ part, offset }, n) => {
      const start = locate(Number.isFinite(offset) ? offset : 0);
      const answer = cedar.policyToJson(part);
      if (answer.type === "failure") {
        problems.push(...answer.errors.map((e) => problemOf(e, file, part, start)));
        return;
      }
      const { effect, principal, annotations = {} } = answer.json;
      const id = annotations.id ?? `${file}#${n + 1}`;
      if (ids.has(id)) {
        const whose = id === ALLOW_ID ? "the runtime's own policy's" : "another policy's";
        problems.push({ file, line: start.line, message: `the id "${id}" is ${whose}: give this one another @id` });
        return;
      }
      ids.add(id);
      policies.push({
        id,
        text: part,
        file,
        ...start,
        effect,
        ...(annotations.hold !== undefined && { hold: annotations.hold }),
        ...(annotations.title !== undefined && { title: annotations.title }),
        ...(annotations.reason !== undefined && { reason: annotations.reason }),
        ...scopeOf(principal),
      });
    });
  }
  return { policies, problems };
}

/** A permit's `scope`: whom its principal names, when that is exactly the visitors or `anonymous`. */
function scopeOf(principal: PolicyJson["principal"]): Pick<CedarPolicySource, "scope"> {
  if (!("entity" in principal) || !("id" in principal.entity)) return {};
  const { op, entity } = principal;
  const is = ({ type, id }: { type: string; id: string }) => entity.type === type && entity.id === id;
  if (op === "in" && is(uid("Group", VISITORS))) return { scope: VISITORS };
  if (op === "==" && is(uid("Principal", ANONYMOUS))) return { scope: ANONYMOUS };
  return {};
}

/**
 * The policies checked against the schema of the resolved config (`validate`, strict), and what
 * Cedar cannot check: a `permit` for anyone but the visitors or `anonymous` (the runtime's is the
 * only one for people and agents), and a `@hold` naming neither a declared group, nor a declared
 * person, nor `on-behalf-of`. In the order written, each at its
 * file, line and column, once per place: a policy scoped to every action fails the same way for each.
 */
export function validatePolicies(
  resolved: Pick<ResolvedConfig, "ops" | "workflows" | "collections">,
  policies: readonly CedarPolicySource[],
  people: readonly PeopleResource[],
): PolicyProblem[] {
  const answer = cedarWasm().validate({
    schema: schemaOf(resolved, people),
    policies: { staticPolicies: Object.fromEntries(policies.map((p) => [p.id, p.text])) },
    validationSettings: { mode: "strict" },
  });
  if (answer.type === "failure") return answer.errors.map((e) => ({ message: messageOf(e) }));
  return policies.flatMap((p) => {
    const place = { file: p.file, line: p.line, policy: p.id };
    const places = new Set<string>();
    const cedar = answer.validationErrors
      .filter(({ policyId }) => policyId === p.id)
      .map(({ error }) => ({ ...problemOf(error, p.file, p.text, p), policy: p.id }))
      .filter(({ line, column }) => {
        // Cedar's errors without a place are each their own.
        if (column === undefined) return true;
        const at = `${line}:${column}`;
        return !places.has(at) && Boolean(places.add(at));
      })
      .toSorted((a, b) => a.line! - b.line! || (a.column ?? 0) - (b.column ?? 0));
    const ours: PolicyProblem[] = [];
    if (p.effect === "permit") {
      if (p.scope === undefined) {
        ours.push({
          ...place,
          message:
            'a permit is allowed only for visitors: its principal must be `in Sanoma::Group::"visitors"` or ' +
            '`== Sanoma::Principal::"anonymous"`; for people and agents every call no forbid refuses is allowed already',
        });
      } else if (p.hold !== undefined) {
        ours.push({ ...place, message: "a permit holds nothing: write the @hold on a forbid" });
      }
    } else if (p.hold !== undefined && p.hold !== ON_BEHALF_OF && approverOf(p.hold, people) === undefined) {
      ours.push({ ...place, message: `@hold("${p.hold}") names no declared group or person, nor "${ON_BEHALF_OF}"` });
    }
    return [...cedar, ...ours];
  });
}

/**
 * The policy a repo's Cedar files make, the runtime's `permit` added; its `version` a hash of the
 * policies' ids and text. The runtime's permit leaves visitors out (`isVisitor`) of a run's start,
 * a direct call (a call of the `call` workflow) and a preview not `inRun`: those are asked of the
 * company's permits alone first. Any other call in a run is decided as anyone's, so a visitor let
 * start a run makes its calls, forbids holding still. It decides each call with
 * `statefulIsAuthorized` over the policy set and the schema of `resolved` (`schemaOf`), each parsed once:
 *
 * - a visitor's start or direct call no company `permit` allows: `deny`, `VISITOR_DENIED`, never
 *   held, so a visitor cannot ask anyone for what no policy lets it do;
 * - allow: `allow`, with the policies that allowed as `reasons`;
 * - deny, a determining `forbid` without `@hold`: `deny` with its `@reason`, or "Refused by <id>";
 * - deny by `@hold` forbids only: each lifted once an approval addressed to its approver and
 *   covering the operation is approved (`approvedFor`); allowed when all are, else `approve` for
 *   the first, in the order written, with its `@title` and its id as `reasons`.
 *
 * An approver is a declared group (`{ group }`), a declared person's id, or the principal's
 * `onBehalfOf`; a principal acting for no one makes `on-behalf-of` a deny, "cannot resolve
 * approver". A policy that fails to evaluate is a deny naming it (Cedar would skip it), as is one
 * reading a field a `before` lacks: a record saved under fields since changed is asked about
 * without the schema, so it can still be fixed or deleted.
 * `preview` asks the same ahead of a call, its context unknown; `start`, about a run's start.
 */
export function cedarPolicy(
  resolved: Pick<ResolvedConfig, "ops" | "workflows" | "collections">,
  policies: readonly CedarPolicySource[],
  people: readonly PeopleResource[],
): Policy {
  const cedar = cedarWasm();
  const schema = schemaOf(resolved, people);
  const staticPolicies = { ...Object.fromEntries(policies.map((p) => [p.id, p.text])), [ALLOW_ID]: ALLOW };
  // What lets a visitor in at a start or a direct call: the company's permits alone, the forbids aside.
  const permits = Object.fromEntries(policies.filter((p) => p.effect === "permit").map((p) => [p.id, p.text]));
  const version = hash(staticPolicies);
  // Cedar caches both per thread, by name: one for these policies over this schema, and its permits.
  const set = `sanoma-${hash({ staticPolicies, schema })}`;
  const permitsSet = `${set}-permits`;
  for (const answer of [
    cedar.preparsePolicySet(set, { staticPolicies }),
    cedar.preparsePolicySet(permitsSet, { staticPolicies: permits }),
    cedar.preparseSchema(set, schema),
  ]) {
    if (answer.type === "failure") {
      throw new Error(`The Cedar policies do not parse: ${answer.errors.map(messageOf).join("; ")}`);
    }
  }
  const hasPermits = Object.keys(permits).length > 0;
  const directory = directoryOf(people);

  /**
   * The determining `forbid`s, in the order written, each with whom it holds for: the first that
   * refuses (no `@hold`, else a hold for no one), or the holds.
   */
  const forbidsOf = (ids: readonly string[], principal: Principal) => {
    const holds = policies
      .filter((p) => p.effect === "forbid" && ids.includes(p.id))
      .map((p) => ({ p, approver: p.hold === undefined ? undefined : holdOf(p.hold, principal, people) }));
    const refusing = holds.find(({ p }) => p.hold === undefined) ?? holds.find(({ approver }) => !approver);
    return { refusing: refusing?.p, holds };
  };

  /** The entity type `action` acts on, as the schema has it. */
  const appliesTo = (action: string) => schema[NAMESPACE]?.actions[action]?.appliesTo?.resourceTypes?.[0];

  /**
   * What `request` is about: a workflow start on its `Workflow`; an operation on its target, in its
   * collection for `data`; one on an entity type with attributes (a merge's `Change`) with those `entity` gives.
   */
  const requestOf = (
    principal: Principal,
    action: string,
    target: string | undefined,
    context: (names: string[]) => Record<string, unknown>,
    entity: (names: string[]) => Record<string, unknown>,
  ) => {
    const entities = directory.entities(principal);
    const on = appliesTo(action);
    const shape = on === undefined ? undefined : shapeOf(schema, on);
    let resource;
    if (action.startsWith(WORKFLOW_ACTION)) {
      resource = uid("Workflow", action.slice(WORKFLOW_ACTION.length));
    } else if (shape) {
      resource = uid(on!, target ?? action);
      const attrs = cedarValue(entity(Object.keys(shape.attributes)), shape) ?? {};
      entities.push({ uid: resource, attrs: attrs as Record<string, CedarValueJson>, parents: [] });
    } else {
      resource = uid("Target", target ?? action);
      const op = resolved.ops.get(action);
      const parents = op?.vendor === DATA_VENDOR ? [uid("Collection", op.resource)] : [];
      entities.push({ uid: resource, attrs: {}, parents });
    }
    const type = contextTypeOf(schema, action);
    return {
      principal: uid("Principal", principal.id),
      action: uid("Action", action),
      resource,
      context: (type ? cedarValue(context(Object.keys(type.attributes)), type) : {}) as Record<string, CedarValueJson>,
      entities,
    };
  };

  /**
   * May `actor` take `action` on `target` with `context`, given the run's `approvals` so far; at a
   * start or a direct call (`atStart`), a visitor only where a company permit lets it in. `entity`,
   * the attributes of what it acts on, when that has any (a `Change`).
   */
  const authorize = (
    actor: Principal,
    action: string,
    target: string | undefined,
    context: Record<string, unknown>,
    approvals: PolicyCall["run"]["approvals"],
    atStart: boolean,
    entity: Record<string, unknown> = {},
  ): Decision => {
    const principal = directory.principal(actor);
    const attrs = () => entity;
    /** The answer of the policy set `id`. */
    const ask = (id: string) => {
      const check = (asked: Record<string, unknown>) =>
        cedar.statefulIsAuthorized({
          ...requestOf(principal, action, target, () => asked, attrs),
          preparsedSchemaName: set,
          validateRequest: true,
          preparsedPolicySetId: id,
        });
      const answer = check(context);
      // A record saved under fields since changed does not fit the schema as `before`. When the rest
      // of the call does, it is asked again without the schema (the context is plain values), the
      // action's groups given as entities: a policy reading a field the record lacks fails, so denies.
      const { before, ...rest } = context;
      if (answer.type === "success" || before === undefined || check(rest).type === "failure") return answer;
      const request = requestOf(principal, action, target, () => context, attrs);
      const groups = schema[NAMESPACE]?.actions[action]?.memberOf ?? [];
      request.entities.push({ uid: request.action, attrs: {}, parents: groups.map((g) => uid("Action", g.id)) });
      return cedar.statefulIsAuthorized({ ...request, preparsedPolicySetId: id });
    };
    // Refused, never held: a visitor cannot ask anyone for what no policy lets it do.
    if (atStart && isVisitor(principal)) {
      const permitted = hasPermits ? ask(permitsSet) : undefined;
      // A request the schema refuses is told below, as anyone's; a permit that fails, by its id.
      if (permitted?.type !== "failure" && permitted?.response.decision !== "allow") {
        const failed = permitted?.response.diagnostics.errors[0];
        if (failed) return deny(`${failed.policyId} failed: ${messageOf(failed.error)}`, [failed.policyId]);
        return deny(VISITOR_DENIED);
      }
    }
    const answer = ask(set);
    // A request the schema refuses (an input Cedar cannot hold) is denied, not an error of the call.
    if (answer.type === "failure")
      return deny(`The call does not fit the Cedar schema: ${answer.errors.map(messageOf).join("; ")}`);
    const { decision, diagnostics } = answer.response;
    const failed = diagnostics.errors[0];
    if (failed) return deny(`${failed.policyId} failed: ${messageOf(failed.error)}`, [failed.policyId]);
    const reasons = diagnostics.reason;
    if (decision === "allow") return allow(reasons);
    const { refusing, holds } = forbidsOf(reasons, principal);
    if (refusing) {
      return deny(
        refusing.hold === undefined ? (refusing.reason ?? `Refused by ${refusing.id}`) : "cannot resolve approver",
        reasons,
      );
    }
    const waiting = holds.find(({ approver }) => !approvedFor(approvals, action, approver!));
    if (!waiting) return allow(reasons);
    const approver = waiting.approver!;
    const title = waiting.p.title ?? `${action} needs ${approverLabel(approver)}`;
    return approve(approver, { title, reasons: [waiting.p.id] });
  };

  const decide = (call: PolicyCall): Decision =>
    authorize(
      call.actor,
      call.op.id,
      call.target,
      {
        input: call.input,
        ...(call.before !== undefined && { before: call.before }),
        ...(call.connection && {
          connection: {
            id: call.connection.id,
            vendor: call.connection.vendor,
            method: call.connection.method,
            account: call.connection.account,
            revision: call.connection.revision,
            scopes: call.connection.scopes,
          },
        }),
      },
      call.run.approvals,
      call.run.workflow === CALL_WORKFLOW,
      call.entity,
    );

  const start = (actor: Principal, workflow: string, input: unknown, approvals: readonly ApprovalState[] = []) =>
    authorize(actor, `${WORKFLOW_ACTION}${workflow}`, undefined, { input }, approvals, true);

  const preview = (requests: readonly PreviewRequest[]): PreviewAnswer[] =>
    requests.map(({ principal: actor, action, resource, inRun }) => {
      const principal = directory.principal(actor);
      const partial = (asked: Record<string, string>) => {
        const answer = cedar.isAuthorizedPartial({
          // A change's facts unknown too: a rule on them depends, one on any change holds.
          ...requestOf(principal, action.id, resource, unknown, unknown),
          schema,
          validateRequest: false,
          policies: { staticPolicies: asked },
        });
        if (answer.type === "failure") throw new Error(answer.errors.map(messageOf).join("; "));
        return answer.response;
      };
      if (!inRun && isVisitor(principal)) {
        const gate = hasPermits ? partial(permits) : undefined;
        if (gate?.decision !== "allow") {
          // A permit the input decides: the answer depends on it, whatever the rest says.
          const open = policies.find((p) => gate?.nontrivialResiduals.includes(p.id));
          return open ? { answer: "depends", rule: ruleOf(open) } : { answer: "deny" };
        }
      }
      const { decision, mustBeDetermining, nontrivialResiduals, residuals } = partial(staticPolicies);
      if (decision === "allow") return { answer: "allow" };
      if (decision === "deny") {
        const { refusing, holds } = forbidsOf(mustBeDetermining, principal);
        const first = holds[0];
        if (refusing || !first) return { answer: "deny", ...(refusing && { rule: ruleOf(refusing) }) };
        return { answer: "hold", rule: ruleOf(first.p), approver: first.approver! };
      }
      // Undecided: a residual forbid whose conditions fold to false cannot apply.
      const open = policies.find((p) => nontrivialResiduals.includes(p.id) && mayApply(residuals[p.id]!));
      return open ? { answer: "depends", rule: ruleOf(open) } : { answer: "allow" };
    });

  return Object.freeze(Object.assign(decide, { version, preview, start }));
}

/**
 * Whether a company `permit` could let a visitor take `action`, in its action group `group`
 * (`start`, or its operation's `effect:<effect>`): asked of the permits whose `scope` is in
 * `scopes`, each with its principal taken as its scope says and its `when` and `unless` left out,
 * on the workflow a start names, or on any target. False means none can apply, so a visitor's
 * start or direct call of it is refused whatever its input (`VISITOR_DENIED`).
 */
export function visitorPermits(
  policies: readonly CedarPolicySource[],
): (scopes: ReadonlySet<string>, action: string, group: string) => boolean {
  const cedar = cedarWasm();
  const permits = policies.flatMap(({ id, effect, scope, text }) => {
    if (effect !== "permit" || scope === undefined) return [];
    const answer = cedar.policyToJson(text);
    if (answer.type !== "success") return [];
    const json: PolicyJson = { ...answer.json, principal: { op: "All" }, conditions: [] };
    return [{ id, scope, json }];
  });
  return (scopes, action, group) => {
    const asked = permits.filter((p) => scopes.has(p.scope));
    if (!asked.length) return false;
    const uidOf = uid("Action", action);
    const answer = cedar.isAuthorizedPartial({
      principal: uid("Principal", ANONYMOUS),
      action: uidOf,
      // An operation's target is the call's: unknown, so a permit naming one may apply.
      resource: action.startsWith(WORKFLOW_ACTION) ? uid("Workflow", action.slice(WORKFLOW_ACTION.length)) : null,
      context: {},
      entities: [{ uid: uidOf, attrs: {}, parents: [uid("Action", group)] }],
      policies: { staticPolicies: Object.fromEntries(asked.map((p) => [p.id, p.json])) },
    });
    // A request Cedar cannot evaluate is not a refusal this can be sure of.
    return answer.type === "failure" || answer.response.decision !== "deny";
  };
}

/**
 * The policy of the repo at `root`: its `policies/**\/*.cedar` over `resolved` and the people its
 * data files declare (`readPeople`, `cedarPolicy`), or `allowAll` when it has none. With problems
 * (`loadPolicies`, `validatePolicies`), each a printable line (`file:line:col: <policy id>:
 * <message>`), a policy that refuses every call, start and preview naming the first: a repo never
 * runs on part of its rules. `policies` are what it is made from: undefined while they have problems.
 */
export function policyAt(
  root: string | undefined,
  resolved: Pick<ResolvedConfig, "ops" | "workflows" | "collections">,
): { policy: Policy; policies?: CedarPolicySource[]; problems: string[] } {
  const files = root === undefined ? [] : readPolicyFiles(root);
  if (!files.length) return { policy: allowAll, policies: [], problems: [] };
  const { people } = readPeople(root);
  const { policies, problems } = loadPolicies(files);
  problems.push(...validatePolicies(resolved, policies, people));
  if (!problems.length) return { policy: cedarPolicy(resolved, policies, people), policies, problems: [] };
  const lines = problems.map(({ policy, ...p }) =>
    problemLine({ ...p, message: policy ? `${policy}: ${p.message}` : p.message }),
  );
  return { policy: denyAll(`The policies do not hold: ${lines[0]}`), problems: lines };
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

const uid = (type: string, id: string) => ({ type: `${NAMESPACE}::${type}`, id });
/** Every field of a context unknown: partial evaluation leaves what depends on it. */
const unknown = (names: string[]) =>
  Object.fromEntries(names.map((name) => [name, { __extn: { fn: "unknown", arg: name } }]));

/** Whom `@hold(hold)` holds the call for, resolved for `principal`: undefined when it names no one. */
const holdOf = (hold: string, principal: Principal, people: readonly PeopleResource[]): Approver | undefined =>
  hold === ON_BEHALF_OF ? principal.onBehalfOf : approverOf(hold, people);

interface Directory {
  /** The principal with the groups and `onBehalfOf` it is declared with added. */
  principal(actor: Principal): Principal;
  /** What a request about `actor` needs: its entity, and that of whom it acts for. */
  entities(actor: Principal): EntityJson[];
}

/** The people as Cedar entities, made once: each a `Principal` in its groups, with `onBehalfOf` when it acts for someone. */
function directoryOf(people: readonly PeopleResource[]): Directory {
  const groups = new Set(groupNamesOf(people));
  const principal = (actor: Principal): Principal => {
    // A visitor is told by its id, as `admit` takes it: never in a declared group.
    if (isVisitor(actor)) return admit(actor, { people, problems: [] });
    // An admitted principal (`admit`) carries its groups as the files say now: those are taken as
    // they are. One without groups is given those declared when the policy was made.
    const declared = actor.groups === undefined ? principalOf(actor.id, people) : undefined;
    const onBehalfOf = actor.onBehalfOf ?? declared?.onBehalfOf;
    return {
      ...actor,
      groups: [...new Set([...(actor.groups ?? []), ...(declared?.groups ?? [])])],
      ...(onBehalfOf !== undefined && { onBehalfOf }),
    };
  };
  const entityOf = (p: Principal): EntityJson => ({
    uid: uid("Principal", p.id),
    attrs: p.onBehalfOf === undefined ? {} : { onBehalfOf: { __entity: uid("Principal", p.onBehalfOf) } },
    // Only the groups the schema enumerates: Cedar refuses any other.
    parents: (p.groups ?? []).filter((g) => groups.has(g)).map((g) => uid("Group", g)),
  });
  const declared = new Map(principalIdsOf(people).map((id) => [id, entityOf(principal({ id }))]));
  return {
    principal,
    entities: (actor) => {
      const actingFor =
        actor.onBehalfOf === undefined || actor.onBehalfOf === actor.id ? undefined : declared.get(actor.onBehalfOf);
      return [entityOf(actor), ...(actingFor ? [actingFor] : [])];
    },
  };
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

/** A Cedar error in `text`, which starts at `start` in `file` (the file's start when it is the file), as a problem at its place. */
function problemOf(
  error: DetailedError,
  file: string,
  text: string,
  start: Place = { line: 1, column: 1 },
): PolicyProblem {
  const byte = error.sourceLocations?.[0]?.start;
  if (byte === undefined) return { file, line: start.line, message: messageOf(error) };
  // Cedar counts bytes; a line and column count characters.
  const at = locator(text)(Buffer.from(text).subarray(0, byte).toString().length);
  const place =
    at.line === 1
      ? { line: start.line, column: start.column + at.column - 1 }
      : { line: start.line + at.line - 1, column: at.column };
  return { file, ...place, message: messageOf(error) };
}
