import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { CedarValueJson, DetailedError, EntityJson, Expr, PolicyJson } from "@cedar-policy/cedar-wasm/nodejs";
import { locator } from "./ast.ts";
import type { ResolvedConfig } from "./config.ts";
import type { Approver, Principal } from "./define.ts";
import { filesUnder } from "./paths.ts";
import {
  allow,
  allowAll,
  approve,
  approvedFor,
  type Decision,
  deny,
  type Policy,
  type PolicyCall,
  type PreviewAnswer,
  type PreviewRequest,
} from "./policy.ts";
import { readPeople } from "./resources.ts";
import { cedarValue, cedarWasm, contextTypeOf, messageOf, NAMESPACE, schemaOf } from "./schema.ts";
import {
  approverLabel,
  approverOf,
  DATA_VENDOR,
  groupNamesOf,
  type PeopleResource,
  principalIdsOf,
  principalOf,
  problemLine,
  WORKFLOW_ACTION,
} from "./shared.ts";

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

/** The `@hold` that addresses the principal's `onBehalfOf`. */
const ON_BEHALF_OF = "on-behalf-of";

type Place = { line: number; column: number };

/** `<root>/policies/**\/*.cedar`, sorted by path, each relative to the root with `/` between its parts. */
export function readPolicyFiles(root: string): { file: string; text: string }[] {
  return filesUnder(join(root, POLICIES_DIR), (name) => name.endsWith(".cedar")).map((path) => ({
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
      const { effect, annotations = {} } = answer.json;
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
      });
    });
  }
  return { policies, problems };
}

/**
 * The policies checked against the schema of the resolved config (`validate`, strict), and what
 * Cedar cannot check: a `permit` (the runtime's is the only one), and a `@hold` naming neither a
 * declared group, nor a declared person, nor `on-behalf-of`. In the order written, each at its
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
      ours.push({ ...place, message: "a permit changes nothing: every call no forbid refuses is allowed already" });
    } else if (p.hold !== undefined && p.hold !== ON_BEHALF_OF && approverOf(p.hold, people) === undefined) {
      ours.push({ ...place, message: `@hold("${p.hold}") names no declared group or person, nor "${ON_BEHALF_OF}"` });
    }
    return [...cedar, ...ours];
  });
}

/**
 * The policy a repo's Cedar files make, the runtime's `permit` added; `kind` is `cedar`, and its
 * `version` a hash of the policies' ids and text. It decides each call with `statefulIsAuthorized`
 * over the policy set and the schema of `resolved` (`schemaOf`), each parsed once:
 *
 * - allow: `allow`, with the policies that allowed as `reasons`;
 * - deny, a determining `forbid` without `@hold`: `deny` with its `@reason`, or "Refused by <id>";
 * - deny by `@hold` forbids only: each lifted once an approval addressed to its approver and
 *   covering the operation is approved (`approvedFor`); allowed when all are, else `approve` for
 *   the first, in the order written, with its `@title` and its id as `reasons`.
 *
 * An approver is a declared group (`{ group }`), a declared person's id, or the principal's
 * `onBehalfOf`; a principal acting for no one makes `on-behalf-of` a deny, "cannot resolve
 * approver". A policy that fails to evaluate is a deny naming it (Cedar would skip it).
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
  const version = hash(staticPolicies);
  // Cedar caches both per thread, by name: one for these policies over this schema.
  const set = `sanoma-${hash({ staticPolicies, schema })}`;
  for (const answer of [cedar.preparsePolicySet(set, { staticPolicies }), cedar.preparseSchema(set, schema)]) {
    if (answer.type === "failure") {
      throw new Error(`The Cedar policies do not parse: ${answer.errors.map(messageOf).join("; ")}`);
    }
  }
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

  /** What `request` is about: a workflow start on its `Workflow`, an operation on its target, in its collection for `data`. */
  const requestOf = (
    principal: Principal,
    action: string,
    target: string | undefined,
    context: (names: string[]) => Record<string, unknown>,
  ) => {
    const entities = directory.entities(principal);
    let resource;
    if (action.startsWith(WORKFLOW_ACTION)) {
      resource = uid("Workflow", action.slice(WORKFLOW_ACTION.length));
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

  /** May `actor` take `action` on `target` with `context`, given the run's `approvals` so far. */
  const authorize = (
    actor: Principal,
    action: string,
    target: string | undefined,
    context: Record<string, unknown>,
    approvals: PolicyCall["run"]["approvals"],
  ): Decision => {
    const principal = directory.principal(actor);
    const answer = cedar.statefulIsAuthorized({
      ...requestOf(principal, action, target, () => context),
      preparsedSchemaName: set,
      preparsedPolicySetId: set,
      validateRequest: true,
    });
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
      { input: call.input, ...(call.before !== undefined && { before: call.before }) },
      call.run.approvals,
    );

  const start = (actor: Principal, workflow: string, input: unknown): Decision =>
    authorize(actor, `${WORKFLOW_ACTION}${workflow}`, undefined, { input }, []);

  const preview = (requests: readonly PreviewRequest[]): PreviewAnswer[] =>
    requests.map(({ principal: actor, action, resource }) => {
      const principal = directory.principal(actor);
      const answer = cedar.isAuthorizedPartial({
        ...requestOf(principal, action.id, resource, unknown),
        schema,
        validateRequest: false,
        policies: { staticPolicies },
      });
      if (answer.type === "failure") throw new Error(answer.errors.map(messageOf).join("; "));
      const { decision, mustBeDetermining, nontrivialResiduals, residuals } = answer.response;
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
 * The policy of the repo at `root`: its `policies/**\/*.cedar` over `resolved` and the people its
 * data files declare (`readPeople`, `cedarPolicy`), or `allowAll` when it has none. With problems
 * (`loadPolicies`, `validatePolicies`), each a printable line (`file:line:col: <policy id>:
 * <message>`), a policy that refuses every call, start and preview naming the first: a repo never
 * runs on part of its rules.
 */
export function policyAt(
  root: string | undefined,
  resolved: Pick<ResolvedConfig, "ops" | "workflows" | "collections">,
): { policy: Policy; problems: string[] } {
  const files = root === undefined ? [] : readPolicyFiles(root);
  if (!files.length) return { policy: allowAll, problems: [] };
  const { people } = readPeople(root);
  const { policies, problems } = loadPolicies(files);
  problems.push(...validatePolicies(resolved, policies, people));
  if (!problems.length) return { policy: cedarPolicy(resolved, policies, people), problems: [] };
  const lines = problems.map(({ policy, ...p }) =>
    problemLine({ ...p, message: policy ? `${policy}: ${p.message}` : p.message }),
  );
  const refused = deny(`The policies do not hold: ${lines[0]}`);
  const policy: Policy = Object.assign(() => refused, {
    start: () => refused,
    preview: (requests: readonly PreviewRequest[]): PreviewAnswer[] => requests.map(() => ({ answer: "deny" })),
  });
  return { policy: Object.freeze(policy), problems: lines };
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
