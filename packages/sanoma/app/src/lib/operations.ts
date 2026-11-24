import type { ConfigDescription, OpEntry } from "sanoma/workflows/describe";
import { DATA_VENDOR, OPERATIONS_VENDOR } from "sanoma/workflows/shared";
import { linkOptions } from "@tanstack/react-router";

// A config's operations as the pages show them, pure over its description: the company's own
// (`defineOperation`), where each operation is shown, what calls it and which vendors it reaches.

/** One collation, so the server and the browser sort alike. */
export const byTitle = (a: string, b: string) => a.localeCompare(b, "en");

/** A company operation's name, as its page and the Connectors page show it: its id less `operations.` and `.run` (`quote`, `crm.score`). */
export const operationName = (id: string) => id.slice(OPERATIONS_VENDOR.length + 1, -".run".length);

/** The config's operations by id, for `select`: built once per config, not on every render. */
export const opsById = (config: Pick<ConfigDescription, "ops">) => new Map(config.ops.map((op) => [op.id, op]));

/**
 * What a workflow calling these operations reaches: each, and the calls inside a company
 * operation among them (its `ops`).
 */
export const opsReached = (ops: ReadonlyMap<string, OpEntry>, ids: readonly string[]) =>
  ids.flatMap((id) => [id, ...(ops.get(id)?.ops ?? [])]);

/** A vendor a workflow calls, by id, and its title (its id when the config gives none). */
export type CalledVendor = { id: string; title: string };

/**
 * The outside vendors these operations reach (`opsReached`), each once, sorted by title: those a
 * connector brings (`config.vendors`), never the built-in `sanoma` and `data`, which call nothing
 * outside.
 */
export const vendorsCalling = (
  config: Pick<ConfigDescription, "vendors">,
  ops: ReadonlyMap<string, OpEntry>,
  ids: readonly string[],
): CalledVendor[] =>
  [...new Set(opsReached(ops, ids).flatMap((id) => ops.get(id)?.vendor ?? []))]
    .flatMap((id) => {
      const vendor = config.vendors[id];
      return vendor ? [{ id, title: vendor.title }] : [];
    })
    .toSorted((a, b) => byTitle(a.title, b.title));

/** The company's own operations (`defineOperation`), each with its name (`operationName`), in the config's order: for `select`. */
export const companyOps = (config: Pick<ConfigDescription, "ops">) =>
  config.ops.filter((op) => op.vendor === OPERATIONS_VENDOR).map((op) => ({ ...op, name: operationName(op.id) }));

/** The company's own operation of this name (`operationName`), if it has one: for `select`, or called with the config. */
export const companyOpNamed = (name: string) => (config: Pick<ConfigDescription, "ops">) =>
  companyOps(config).find((op) => op.name === name);

/**
 * A company operation's file, from the company's root (`operations/quote.ts`,
 * `apps/crm/operations/score.ts`): its absolute `file` from its folder of operations on, with `/`
 * (a Windows path's `\` too). One given to the config from another folder shows its file's name
 * alone, never the path on the machine.
 */
export function operationFile({ app, file = "" }: Pick<OpEntry, "app" | "file">): string {
  const folder = `${app === undefined ? "" : `apps/${app}/`}operations/`;
  const path = file.replaceAll("\\", "/");
  const at = path.lastIndexOf(`/${folder}`);
  return path.slice((at < 0 ? path.lastIndexOf("/") : at) + 1);
}

/** Whether an operation's id is a company operation's (`operations.<name>.run`). */
export const isCompanyOp = (id: string) => id.startsWith(`${OPERATIONS_VENDOR}.`);

/**
 * Where an operation is shown: a company operation's own page, a collection's, or its connector's
 * (a vendor in `config.vendors`); none for another (the runtime's own).
 */
export function opHome(
  { vendors }: Pick<ConfigDescription, "vendors">,
  op: Pick<OpEntry, "id" | "vendor" | "resource">,
) {
  if (op.vendor === OPERATIONS_VENDOR)
    return linkOptions({ to: "/connectors/operations/$name", params: { name: operationName(op.id) } });
  if (op.vendor === DATA_VENDOR) return linkOptions({ to: "/data/$name", params: { name: op.resource } });
  if (vendors[op.vendor]) return linkOptions({ to: "/connectors/$vendor", params: { vendor: op.vendor } });
  return undefined;
}

/**
 * What calls one of these operations: the workflows that reach one (`opsReached`: in `uses`, or
 * through a company operation's), sorted by title, the built-ins left out (`call` may call every
 * direct operation), and the company's own operations that name one in `uses`, by name. A page
 * adds the sites' files (`siteCallers`).
 */
export function callersOf(config: Pick<ConfigDescription, "ops" | "workflows">, ids: readonly string[]) {
  const called = new Set(ids);
  const ops = opsById(config);
  const workflows = config.workflows
    .filter((wf) => !wf.builtin && opsReached(ops, wf.ops).some((op) => called.has(op)))
    .toSorted((a, b) => byTitle(a.title ?? a.name, b.title ?? b.name));
  const operations = companyOps(config).filter((op) => op.ops?.some((id) => called.has(id)));
  return { workflows, operations };
}
