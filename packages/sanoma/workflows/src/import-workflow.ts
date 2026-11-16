import { z } from "zod";
import type { Collection } from "./collection.ts";
import { defineWorkflow, type WorkflowDefinition } from "./define.ts";
import { errorCode, vendorCodeOf } from "./errors.ts";
import {
  byCodePoint,
  IMPORT_BATCH,
  importEntry,
  type ImportInput,
  type ImportOutput,
  importRows,
  mappingProblems,
} from "./import.ts";
import type { Op } from "./op.ts";
import {
  type Deleted,
  type IMPORT_WORKFLOW,
  LIST_LIMIT,
  type MissingLink,
  missingText,
  type Saved,
  writtenName,
} from "./shared.ts";

// The built-in `import` workflow: a sheet's rows into a collection, as a run of the person who
// started it (the app's Import pages). Its rows are read the way the page read them (`importRows`
// and `importEntry`, `import.ts`), matched by key to the records there, read a batch's range of
// keys at a time with `list`, and saved `IMPORT_BATCH` at a time with `saveMany`: a new key with
// `ifAbsent`, a key there with `ifRecord`. The policy decides each entry as a `save`: a denied
// entry, or one changed since it was read, is left as a problem and the batch saved without it;
// a held entry holds its batch, an approval like any run's. A workflow like any other, held to
// the same lint.

/** A collection's operations the import calls, on `ctx.data`. */
interface Calls {
  list(query: { where: Record<string, unknown>; limit: number }): Promise<Saved[]>;
  saveMany(batch: { records: Entry["save"][] }): Promise<(Saved | Deleted)[]>;
}

/** `ctx` as the import calls it: a root collection's at `data.<name>`, an app's at `data.<app>.<name>`. */
type DataCtx = { data: Record<string, Calls & Record<string, Calls>> };

/** A row to save: its number in the sheet, and `saveMany`'s entry for it. */
interface Entry {
  row: number;
  key: string;
  save: { record: Record<string, unknown>; ifAbsent?: true; ifRecord?: Record<string, unknown> };
}

/** A column of the sheet: the field it fills, and what its values stand for. */
const ImportColumnSchema = z.strictObject({
  field: z.string().min(1),
  values: z.record(z.string(), z.string()).optional(),
});

/** The import's input (`ImportInput`), before it is checked against a collection's fields. */
const ImportInputSchema = z.strictObject({
  collection: z.string().min(1),
  mapping: z.array(ImportColumnSchema.nullable()),
  rows: z.array(z.array(z.string())),
  people: z.array(z.string()).optional(),
}) satisfies z.ZodType<ImportInput>;

/**
 * The entries a batch's save refused, each with why: a policy's denial (`data.deniedFor`, each
 * denied key's reason), a record changed since it was read (`conflicts`), or a link to a record
 * that is not there (`missing`). Undefined for any other failure, which ends the run.
 */
function refusedBy(err: unknown): Map<string, string> | undefined {
  const { data, conflicts, missing } = (err ?? {}) as {
    data?: { deniedFor?: Record<string, string> };
    conflicts?: { key: string }[];
    missing?: MissingLink[];
  };
  if (vendorCodeOf(err) === "link_missing" && missing?.length) {
    return new Map(missing.map((m) => [m.key, `${m.field}: ${missingText(m)}`]));
  }
  if (errorCode(err) === "policy_denied" && data?.deniedFor) {
    return new Map(Object.entries(data.deniedFor).map(([key, why]) => [key, `the policy denies saving it: ${why}`]));
  }
  if (vendorCodeOf(err) === "record_changed" && conflicts?.length) {
    return new Map(conflicts.map(({ key }) => [key, "it changed while the sheet was imported: import it again"]));
  }
  return undefined;
}

/** The built-in import workflow over the config's collections: `resolveConfig` adds it when there are any. */
export function importWorkflow(collections: ReadonlyMap<string, Collection>): WorkflowDefinition<any, any> {
  const uses: Op[] = [...collections.values()].flatMap((c) => [c.list, c.saveMany]);
  return defineWorkflow({
    // The literal, held to the one name: the outline finds a workflow by a string, or a const of its own file.
    name: "import" satisfies typeof IMPORT_WORKFLOW,
    title: "Import a spreadsheet",
    trigger: "manual",
    // Refused at the start: a collection the config lacks, or columns its fields do not take.
    input: ImportInputSchema.superRefine((input, issues) => {
      const collection = collections.get(input.collection);
      const wrong = collection
        ? mappingProblems(collection, input.mapping)
        : [`There is no collection ${input.collection}`];
      for (const message of wrong) issues.addIssue({ code: "custom", message });
    }),
    uses,
    run: async (ctx, input: ImportInput): Promise<ImportOutput> => {
      const collection = collections.get(input.collection)!;
      const name = writtenName(collection);
      const app = collection.app;
      const { rows, problems } = importRows(collection, input);
      // By key, as the records are listed: each batch reads one range of keys.
      const sorted = rows.toSorted((a, b) => byCodePoint(a.key, b.key));
      let added = 0;
      let updated = 0;
      let unchanged = 0;
      for (let at = 0; at < sorted.length; at += IMPORT_BATCH) {
        const batch = sorted.slice(at, at + IMPORT_BATCH);
        const last = batch.at(-1)!.key;
        const found = new Map<string, Saved>();
        let where: Record<string, unknown> = { [collection.key]: { gte: batch[0]!.key, lte: last } };
        let more = true;
        while (more) {
          const query = { where, limit: LIST_LIMIT.max };
          const page =
            app === undefined
              ? await (ctx as unknown as DataCtx).data[name]!.list(query)
              : await (ctx as unknown as DataCtx).data[app]![name]!.list(query);
          for (const saved of page) found.set(saved.key, saved);
          more = page.length === LIST_LIMIT.max;
          where = { [collection.key]: { gt: page.at(-1)?.key, lte: last } };
        }
        let entries: Entry[] = [];
        for (const row of batch) {
          const existing = found.get(row.key);
          const entry = importEntry(collection, row, existing);
          if (entry.will === "fix") problems.push({ row: row.row, key: row.key, reason: entry.reason });
          else if (entry.will === "keep") unchanged++;
          else {
            const guard = existing ? { ifRecord: existing.record } : { ifAbsent: true as const };
            entries.push({ row: row.row, key: row.key, save: { record: entry.record, ...guard } });
          }
        }
        while (entries.length > 0) {
          const records = entries.map((entry) => entry.save);
          try {
            if (app === undefined) await (ctx as unknown as DataCtx).data[name]!.saveMany({ records });
            else await (ctx as unknown as DataCtx).data[app]![name]!.saveMany({ records });
            added += records.filter((entry) => entry.ifAbsent).length;
            updated += records.filter((entry) => entry.ifRecord).length;
            entries = [];
          } catch (err) {
            // A denied or changed entry is left for the person; the rest are saved without it.
            const refused = refusedBy(err);
            const kept = entries.filter((entry) => !refused?.has(entry.key));
            if (kept.length === entries.length) throw err;
            for (const entry of entries) {
              const why = refused!.get(entry.key);
              if (why !== undefined) problems.push({ row: entry.row, key: entry.key, reason: why });
            }
            entries = kept;
          }
        }
      }
      return { added, updated, unchanged, problems: problems.toSorted((a, b) => a.row - b.row) };
    },
  });
}
