import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  ADMIN,
  type AdoptInput,
  type AppStepContext,
  errorMessage,
  isRules,
  mayDeclarePeople,
  type PatchInput,
  type PatchOutput,
  peopleSources,
  remoteFor,
  SanomaError,
  type Source,
  type Written,
} from "@sanoma-ai/workflows";
import {
  type DataValue,
  describeConfig,
  formatOptions,
  NotLiteral,
  renameFields,
  setFields,
} from "@sanoma-ai/workflows/describe";

// A data file's change from the app's own pages, in the worker (the built-ins `adopt` and
// `patch`): Adopt (a drifted field's value at the vendor) and a form's Save, each written into the
// checkout (or a draft of it) and committed through the worker's repository, each read, write
// and commit one of the worker's writes (`AppStepContext.serially`), so two never read the same
// file and both write it.

/** The config's root, where its data files are: a config without one has none to write. */
export function rootOf({ resolved }: Pick<AppStepContext, "resolved">): string {
  if (resolved.root === undefined) throw new Error("The config has no root, so its data files cannot be written");
  return resolved.root;
}

/**
 * Adopt: writes what the vendor holds into the data file, for fields a finished drift run found
 * drifted (`paths`, of the resource `id`), by that run's report, never a value the input gives.
 * Then commits the file through the worker's repository, when it has one, as the run's actor. The
 * next drift run reads the file as it is now. Refused (`invalid_input`) for a resource or a field
 * the run found no drift on; failed, saying why, when the file no longer declares the resource or
 * the field's place, or the field is (or holds) a reference to another resource. It does not check
 * that the field still holds what the run read.
 */
export async function adopt(step: AppStepContext, { runId, id, paths }: AdoptInput): Promise<Written> {
  const root = rootOf(step);
  const result = (await step.client.driftReport(runId)).resources.find((r) => r.id === id);
  if (result?.status !== "drifted") throw new SanomaError("invalid_input", `Run ${runId} found no drift on ${id}`);
  const fields: Record<string, DataValue> = {};
  for (const path of paths) {
    const field = result.fields.find((f) => f.path === path);
    if (!field) throw new SanomaError("invalid_input", `${path} of ${id} has not drifted`);
    fields[path] = field.actual as DataValue;
  }
  // The id is `<file>#<export>`, the file relative to the root: the drift run read it there.
  const at = id.lastIndexOf("#");
  const file = id.slice(0, at);
  return step.serially(async () => {
    let text: string;
    try {
      text = await setFields(await readFile(join(root, file), "utf8"), id.slice(at + 1), fields, formatOptions(root));
    } catch (err) {
      throw new Error(`Could not adopt into ${file}: ${errorMessage(err)}`, { cause: err });
    }
    return written(step, file, text, `Adopt ${paths.join(", ")} of ${result.name} from ${result.vendor}`);
  });
}

/**
 * Writes `text` into the checkout's `file` (relative to the root), then commits it through the
 * worker's repository, when it has one, as the run's actor: what Adopt and a patch without a
 * remote land as. Under `serially`, with the read it writes after.
 */
async function written(step: AppStepContext, file: string, text: string, message: string): Promise<Written> {
  const path = join(rootOf(step), file);
  await writeFile(path, text);
  const { source, by } = step;
  if (!source) return { file };
  try {
    const commit = await source.commit({ paths: [relative(source.root, path)], message, author: by.id });
    return { file, ...(commit && { revision: commit.revision }) };
  } catch (err) {
    throw new Error(`Wrote ${file}, but could not commit it: ${errorMessage(err)}`, { cause: err });
  }
}

/**
 * A form's Save: sets `fields` of the declaration at `at` (one the description names: a resource,
 * a collection, a site or an app) in its file (`setFields`), then renames or removes the fields
 * `rename` names (`renameFields`), as the run's actor, and lands it.
 * With a repository that drafts and has a remote a connector's remote half is for, it is a change:
 * the file written in a draft of its own (`ui-<id>`), committed there, and the change opened for
 * review (`SanomaClient.openChange`, carrying `plan` when `at` is a collection's, for its review), whose
 * run holds a change to the rules for `admin`; the change's run id. Otherwise the file is written
 * in the checkout and committed as Adopt does, but a change to the rules (a people file) only by
 * someone in `admin`: `not_approver` for anyone else, since nothing would review it. Refused
 * (`invalid_input`) for a declaration the description does not name, a rename the file cannot
 * take, and, with the writer's reason and the `field`, for a field the file computes or a
 * declaration that is no object literal.
 */
export async function patch(step: AppStepContext, { at, fields, rename = {}, plan }: PatchInput): Promise<PatchOutput> {
  const root = rootOf(step);
  const { client, source, by } = step;
  const description = describeConfig(step.config);
  const named = [
    ...description.resources.map((r) => r.at),
    ...description.collections.map((c) => c.declared?.at),
    ...description.sites.map((s) => s.at),
    ...description.apps.map((a) => a.at),
  ].some((known) => known?.file === at.file && known.export === at.export);
  if (!named) throw new SanomaError("invalid_input", `${at.file}#${at.export} is not a declaration`);
  // A plan is a column change's, so it goes on the change only with a collection's declaration.
  const planned =
    plan !== undefined &&
    description.collections.some((c) => c.declared?.at.file === at.file && c.declared.at.export === at.export);
  const paths = [...Object.keys(fields), ...Object.keys(rename)];
  const message = `Change ${paths.join(", ")} of ${at.export === "default" ? at.file : at.export}`;
  /**
   * The file under `dir` as it is, and with the fields set and renamed; refused, saying why, when
   * they cannot be (a rename's every failure is the text refusing it: a name taken, a field gone).
   */
  const edited = async (dir: string) => {
    try {
      const before = await readFile(join(dir, at.file), "utf8");
      const options = formatOptions(root);
      const set = Object.keys(fields).length ? await setFields(before, at.export, fields, options) : before;
      const text = Object.keys(rename).length
        ? await renameFields(set, at.export, rename, options).catch((err: unknown) => {
            throw err instanceof NotLiteral ? err : new SanomaError("invalid_input", errorMessage(err));
          })
        : set;
      return { before, text };
    } catch (err) {
      if (err instanceof SanomaError) throw err;
      if (err instanceof NotLiteral) {
        throw new SanomaError("invalid_input", err.reason, { ...(err.field && { field: err.field }) });
      }
      throw new Error(`Could not write ${at.file}: ${errorMessage(err)}`, { cause: err });
    }
  };
  if (source?.draft && (await reviewsChanges(step, source))) {
    // The file as the draft has it: main's, which the change is reviewed against.
    const id = `ui-${randomUUID().slice(0, 8)}`;
    try {
      await step.serially(async () => {
        const draft = await source.draft!(id);
        const inDraft = join(draft.root, relative(source.root, root));
        const { text } = await edited(inDraft);
        await writeFile(join(inDraft, at.file), text);
        await draft.commit({ paths: [relative(draft.root, join(inDraft, at.file))], message, author: by.id });
      });
      // No page for its pull request's status to link: the app's origin is no fact the worker has,
      // and a run's input is its starter's to choose.
      return {
        change: await client.openChange({ id, title: message, ...(planned && { plan }) }, { startedBy: by }),
      };
    } catch (err) {
      // No change opened on it (a policy refusing the change, say): the draft would be left behind with nothing to close it.
      await step.serially(async () => source.closeDraft?.(id));
      throw err;
    }
  }
  return step.serially(async () => {
    const { before, text } = await edited(root);
    const rules = isRules(at.file) || mayDeclarePeople(before) || peopleSources(root).has(at.file);
    if (rules && by.groups?.includes(ADMIN) !== true) {
      throw new SanomaError(
        "not_approver",
        `A change to ${at.file} waits for an admin, and this company has no remote to review on`,
        { approver: { group: ADMIN } },
      );
    }
    return written(step, at.file, text, message);
  });
}

/**
 * Whether a change can be reviewed: the repository drafts and has a remote that a connector's
 * remote half is for (`remoteFor`), as opening a change needs.
 */
async function reviewsChanges({ resolved }: AppStepContext, source: Source): Promise<boolean> {
  if (!source.draft || !source.diff) return false;
  const url = await source.remoteUrl?.();
  return url !== undefined && remoteFor(resolved.remotes, url) !== undefined;
}
