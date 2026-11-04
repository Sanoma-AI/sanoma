// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ADMIN, errorMessage, isRules, mayDeclarePeople, peopleSources, type Principal } from "@sanoma-ai/workflows";
import { type DataValue, formatOptions, NotLiteral, setFields } from "@sanoma-ai/workflows/describe";
import { type AdoptRequest, type AdoptResponse, ApiError, type PatchRequest, type PatchResponse } from "../../api.ts";
import type { AppContext } from "../../context.ts";
import { changePage, remoteOf } from "../core.ts";

// A data file's change from the app's own pages: Adopt (a drifted field's value at the vendor) and
// a form's Save, each written into the checkout (or a draft of it) and committed through the
// repository, so only where the checkout is (`AppContext.local`).

/** The adopt or patch under way, if any: one at a time, so two never read the same file and both write it. */
let adopting: Promise<unknown> = Promise.resolve();

/**
 * Adopt: writes what the vendor holds into the data file, for fields a finished drift run found
 * drifted (`paths`, of the resource `id`), by that run's report, never a value the request gives.
 * Then commits the file through the app's source, when it has one, as the actor. The next drift
 * run reads the file as it is now. One adopt runs at a time. A 409 when the file no longer
 * declares the resource or the field's place, or the field is (or holds) a reference to another
 * resource; it does not check that the field still holds what the run read.
 */
export function adopt(app: AppContext, actor: Principal, request: AdoptRequest): Promise<AdoptResponse> {
  const done = adopting.then(() => adoptNow(app, actor, request));
  adopting = done.catch(() => undefined);
  return done;
}

async function adoptNow(app: AppContext, actor: Principal, { runId, id, paths }: AdoptRequest): Promise<AdoptResponse> {
  const { client, resolved } = app;
  const result = (await client.driftReport(runId)).resources.find((r) => r.id === id);
  if (result?.status !== "drifted") {
    throw new ApiError(404, { error: `Run ${runId} found no drift on ${id}`, code: "invalid_input" });
  }
  const fields: Record<string, DataValue> = {};
  for (const path of paths) {
    const field = result.fields.find((f) => f.path === path);
    if (!field) throw new ApiError(400, { error: `${path} of ${id} has not drifted`, code: "invalid_input" });
    fields[path] = field.actual as DataValue;
  }
  if (resolved.root === undefined) throw new Error("The config has no root, so its data files cannot be written");
  // The id is `<file>#<export>`, the file relative to the root: the drift run read it there.
  const at = id.lastIndexOf("#");
  const file = id.slice(0, at);
  let text: string;
  try {
    text = await setFields(
      await readFile(join(resolved.root, file), "utf8"),
      id.slice(at + 1),
      fields,
      formatOptions(resolved.root),
    );
  } catch (err) {
    throw new ApiError(409, { error: `Could not adopt into ${file}: ${errorMessage(err)}` });
  }
  return written(app, actor, file, text, `Adopt ${paths.join(", ")} of ${result.name} from ${result.vendor}`);
}

/**
 * Writes `text` into the checkout's `file` (relative to the root), then commits it through the
 * app's source, when it has one, as `actor`: what Adopt and a patch without a remote land as.
 */
async function written(
  { resolved, local }: AppContext,
  actor: Principal,
  file: string,
  text: string,
  message: string,
): Promise<{ file: string; revision?: string }> {
  const path = join(resolved.root!, file);
  await writeFile(path, text);
  const source = local?.source;
  if (!source) return { file };
  try {
    const commit = await source.commit({ paths: [relative(source.root, path)], message, author: actor.id });
    return { file, ...(commit && { revision: commit.revision }) };
  } catch (err) {
    // Said, not hidden behind a 500's "Something went wrong": the file is written, and uncommitted.
    throw new ApiError(500, { error: `Wrote ${file}, but could not commit it: ${errorMessage(err)}` });
  }
}

/**
 * A form's Save: sets `fields` of the declaration at `at` (one the description names: a resource,
 * a collection, a site or an app) in its file (`setFields`), as `actor`, and lands it. With a
 * repository that drafts and has a remote a connector's remote half is for, it is a change: the
 * file written in a draft of its own (`ui-<id>`), committed there, and the change opened for
 * review (`SanomaClient.openChange`), whose run holds a change to the rules for `admin`; the
 * change's run id. Otherwise the file is written in the checkout and committed as Adopt does, but
 * a change to the rules (a people file) only by someone in `admin`: a 403 for anyone else, since
 * nothing would review it. A 404 for a declaration the description does not name; a 409, with the
 * writer's reason, for a field the file computes or a declaration that is no object literal.
 * Patches run one at a time, with Adopt's.
 */
export function patch(
  app: AppContext,
  actor: Principal,
  request: PatchRequest,
  origin?: string,
): Promise<PatchResponse> {
  const done = adopting.then(() => patchNow(app, actor, request, origin));
  adopting = done.catch(() => undefined);
  return done;
}

async function patchNow(
  app: AppContext,
  actor: Principal,
  { at, fields }: PatchRequest,
  origin: string | undefined,
): Promise<PatchResponse> {
  const { snapshot, resolved, client } = app;
  const { description } = snapshot;
  const source = app.local?.source;
  const named = [
    ...description.resources.map((r) => r.at),
    ...description.collections.map((c) => c.declared?.at),
    ...description.sites.map((s) => s.at),
    ...description.apps.map((a) => a.at),
  ].some((known) => known?.file === at.file && known.export === at.export);
  if (!named) {
    throw new ApiError(404, { error: `${at.file}#${at.export} is not a declaration`, code: "invalid_input" });
  }
  if (resolved.root === undefined) throw new Error("The config has no root, so its files cannot be written");
  const root = resolved.root;
  const message = `Change ${Object.keys(fields).join(", ")} of ${at.export === "default" ? at.file : at.export}`;
  /** The file under `dir` as it is, and with the fields set; a 409 saying why they cannot be. */
  const edited = async (dir: string) => {
    try {
      const before = await readFile(join(dir, at.file), "utf8");
      return { before, text: await setFields(before, at.export, fields, formatOptions(root)) };
    } catch (err) {
      if (err instanceof NotLiteral)
        throw new ApiError(409, { error: err.reason, ...(err.field && { field: err.field }) });
      throw new ApiError(409, { error: `Could not write ${at.file}: ${errorMessage(err)}` });
    }
  };
  if (source?.draft && reviewsChanges(app)) {
    // The file as the draft has it: main's, which the change is reviewed against.
    const id = `ui-${randomUUID().slice(0, 8)}`;
    const draft = await source.draft(id);
    const inDraft = join(draft.root, relative(source.root, root));
    try {
      const { text } = await edited(inDraft);
      await writeFile(join(inDraft, at.file), text);
      await draft.commit({ paths: [relative(draft.root, join(inDraft, at.file))], message, author: actor.id });
      const page = origin && changePage(id, origin);
      return { change: await client.openChange({ id, title: message, ...(page && { page }) }, { startedBy: actor }) };
    } catch (err) {
      // No change opened on it (a policy refusing the change, say): the draft would be left behind with nothing to close it.
      await source.closeDraft?.(id);
      throw err;
    }
  }
  const { before, text } = await edited(root);
  if (
    (isRules(at.file) || mayDeclarePeople(before) || peopleSources(root).has(at.file)) &&
    !actor.groups?.includes(ADMIN)
  ) {
    throw new ApiError(403, {
      error: `A change to ${at.file} waits for an admin, and this company has no remote to review on`,
      code: "not_approver",
    });
  }
  return written(app, actor, at.file, text, message);
}

/**
 * Whether a change can be reviewed: the repository drafts and has a remote that a connector's
 * remote half is for (`remoteFor`), as opening a change needs.
 */
function reviewsChanges(app: AppContext): boolean {
  const source = app.local?.source;
  return !!source?.draft && !!source.diff && remoteOf(app) !== undefined;
}
