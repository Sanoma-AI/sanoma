import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlanAction } from "@sanoma-ai/workflows";
import type { PlanResult, ProviderRef, ResourceState } from "../src/bridge.ts";
import type { ProviderClient } from "../src/configure.ts";
import { type Fixture, releaseSlug, stateId, toPath } from "../src/fixtures.ts";
import { isObject } from "../src/json.ts";

/** A call the replay received, in order: the method and, for a plan, its action. */
export interface ChangeCall {
  method: "configure" | "read" | "plan" | "apply" | "close";
  typeName?: string;
  action?: PlanAction;
}

const sorted = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sorted)
    : isObject(v)
      ? Object.fromEntries(
          Object.keys(v)
            .toSorted()
            .map((k) => [k, sorted(v[k])]),
        )
      : v;

/** JSON with every object's keys sorted, so a request matches a recording whatever order the provider wrote. */
const canonical = (json: string | undefined) => (json ? JSON.stringify(sorted(JSON.parse(json))) : "");

const bytes = (base64: unknown) => Buffer.from(typeof base64 === "string" ? base64 : "", "base64");

/** A plan or apply request as a recording holds it: `planned` as base64. */
const asRequest = (r: { priorStateJson?: string; configJson?: string; planned?: Uint8Array }) => ({
  priorStateJson: r.priorStateJson,
  configJson: r.configJson,
  ...(r.planned?.length && { planned: Buffer.from(r.planned).toString("base64") }),
});

/** What a plan or apply is matched on: everything it carries but the provider's private data. */
const keyOf = (method: "plan" | "apply", typeName: string, r: Record<string, unknown>) =>
  [method, typeName, canonical(r.priorStateJson as string), canonical(r.configJson as string), r.planned ?? ""].join(
    "\n",
  );

interface Reply {
  typeName?: string;
  stateJson: string;
  private?: string;
  schemaVersion?: string | number;
}

const resourceOf = (r: Reply): ResourceState => ({
  typeName: r.typeName ?? "",
  stateJson: r.stateJson,
  private: bytes(r.private),
  schemaVersion: Number(r.schemaVersion ?? 0),
});

/**
 * A bridge that replays the `plan.json`, `apply.json` and `apply-delete.json` recordings of a
 * release (`replies/<release>/<type>/<slug>/`), matching each request on its type, prior state,
 * config and plan, and fails one it has no recording of. `read` answers with the state it is
 * given (as `hashicorp/null` does), or `gone` once an apply deleted the object with that `id`.
 *
 * Unlike `fakeBridge`, it needs no recorded read, and it records the calls it gets, so the change
 * operations' tests can check their order.
 */
export function changeReplay(fixtures: string | URL, ref: ProviderRef): ProviderClient & { calls: ChangeCall[] } {
  const replies = new Map<string, Record<string, unknown>>();
  const root = join(toPath(fixtures), "replies", releaseSlug(ref));
  for (const type of readdirSync(root)) {
    for (const slug of readdirSync(join(root, type))) {
      for (const name of ["plan.json", "apply.json", "apply-delete.json"]) {
        const file = join(root, type, slug, name);
        if (!existsSync(file)) continue;
        const { request, response } = JSON.parse(readFileSync(file, "utf8")) as Fixture;
        replies.set(keyOf(name.startsWith("plan") ? "plan" : "apply", request.typeName as string, request), response);
      }
    }
  }
  const reply = (method: "plan" | "apply", typeName: string, request: Record<string, unknown>) => {
    const r = replies.get(keyOf(method, typeName, request));
    if (!r) throw new Error(`no recorded ${method} of ${typeName} for ${JSON.stringify(request)}`);
    return r;
  };
  const gone = new Set<string>();
  const calls: ChangeCall[] = [];
  return {
    calls,
    async configure() {
      calls.push({ method: "configure" });
      return { warnings: [] };
    },
    async import(_, typeName, id) {
      throw new Error(`no import of ${typeName} ${id} is recorded`);
    },
    async read(_, typeName, stateJson, priv, schemaVersion) {
      calls.push({ method: "read", typeName });
      if (gone.has(`${typeName}/${stateId(stateJson)}`)) return { gone: true, warnings: [] };
      const resource = { typeName, stateJson, private: priv ?? new Uint8Array(), schemaVersion: schemaVersion ?? 0 };
      return { resource, gone: false, warnings: [] };
    },
    async plan(_, typeName, request): Promise<PlanResult> {
      const r = reply("plan", typeName, asRequest(request));
      const action = String(r.action).replace("ACTION_", "").toLowerCase() as PlanAction;
      calls.push({ method: "plan", typeName, action });
      return {
        action,
        plannedStateJson: (r.plannedStateJson as string | undefined) ?? "",
        unknownPaths: (r.unknownPaths as string[] | undefined) ?? [],
        requiresReplace: (r.requiresReplace as string[] | undefined) ?? [],
        planned: bytes(r.planned),
        plannedPrivate: bytes(r.plannedPrivate),
        warnings: [],
      };
    },
    async apply(_, typeName, request) {
      calls.push({ method: "apply", typeName });
      const r = reply("apply", typeName, asRequest(request));
      if (!request.configJson && request.priorStateJson) gone.add(`${typeName}/${stateId(request.priorStateJson)}`);
      const resource = r.resource as Reply | undefined;
      return { ...(resource && { resource: resourceOf(resource) }), errors: [], warnings: [] };
    },
    async close() {
      calls.push({ method: "close" });
    },
  };
}
