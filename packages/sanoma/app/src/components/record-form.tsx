import type { CollectionEntry } from "sanoma/workflows/describe";
import { errorMessage, type Saved } from "sanoma/workflows/shared";
import { useMutation } from "@tanstack/react-query";
import { FloppyDiskIcon } from "@phosphor-icons/react/dist/csr/FloppyDisk";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { FieldGroup } from "#/components/ui/field.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import type { UntypedApi } from "../api-client.ts";
import { buildInput, fieldsOf, initialValues } from "../form/schema.ts";
import { errorsOf, FieldView, FormFoot, useSchemaForm } from "../form/start-form.tsx";
import { api } from "../queries.ts";
import { Notice } from "./common.tsx";
import { type RecordsView, savedIn } from "./grid/collection.ts";
import { isHidden } from "./grid/plan.ts";
import { STAGED_FIRST } from "./grid/staged.tsx";
import { HistoryLink } from "./record-history.tsx";

// A collection's record form: one form, drawn from the record's JSON Schema as the start form is
// from a workflow's input, to add a record or edit one; and Delete. Each is a change of the page's
// records collection, the grid's (`grid/collection.ts`; an edit in its queue of the record's
// edits, after the grid's), whose handler calls the collection's operation, `data.<name>.save`
// (`ifAbsent` for a new record, `ifRecord` for an edit) or `.delete`, through `api` as the
// person; a held call's toast is the collection's. While the grid has a change staged, Save and
// Delete wait for it: the grid's bar saves or discards it. A hidden field (removed from the
// columns) has no field on it, and an edit keeps its value.

/** An issue's path in a save's input (`record.<field>`), as the form's. */
const inRecord = (path: (string | number)[]) => (path[0] === "record" ? path.slice(1) : path);

/**
 * The record form: a new record's (`saved` none), its people filled in with `actor`, whoever is
 * asking; or `saved`'s, its key read-only, with Delete. `view` is the page's records
 * collection, which a save or a delete changes. Save answers by `onDone` once saved or held for
 * an approval (said with a toast linking to its run); a denial and what the fields refuse show
 * on the form.
 */
export function RecordForm({
  collection: { name, key, record, fields: declared },
  view: { collection: records, edit },
  saved,
  staged,
  actor,
  onDone,
}: {
  collection: CollectionEntry;
  view: RecordsView;
  saved?: Saved | undefined;
  /** While the grid has a change staged, its bar is the one way to save: the form waits for it. */
  staged: boolean;
  actor: string | null | undefined;
  onDone: () => void;
}) {
  const fields = useMemo(
    () => (fieldsOf(record) ?? []).filter((field) => !isHidden(declared[field.key])),
    [record, declared],
  );
  const defaultValues = useMemo(() => {
    if (saved) return initialValues(fields, saved.record);
    const people = actor ? fields.filter((f) => f.kind === "person").map((f) => [f.key, actor]) : [];
    return initialValues(fields, Object.fromEntries(people));
  }, [fields, saved, actor]);
  const form = useSchemaForm(defaultValues, async (values) => {
    const built = buildInput(fields, values);
    if (Object.keys(built.errors).length) return { fields: built.errors };
    const input = built.input;
    const typed = String(input[key] ?? "");
    try {
      // Add makes a record: a key that names one already is the person's to open, not to replace.
      if (!saved && typed && (await (api as UntypedApi).data[name].get({ key: typed }))) {
        return { fields: { [key]: "A record has this key already: open it to change it" } };
      }
      // The hidden fields' values, which the form does not show, kept.
      const kept = Object.entries(saved?.record ?? {}).filter(([field]) => isHidden(declared[field]));
      const tx = saved
        ? edit({ key: saved.key, record: { ...Object.fromEntries(kept), ...input } })
        : records.insert({ key: typed, record: input, updatedAt: new Date().toISOString(), updatedBy: actor ?? "" });
      await tx.when("settled");
      // None when the call is held for an approval: its toast said so.
      if (savedIn(tx, typed))
        toast.success(
          <>
            Saved <HistoryLink name={name} recordKey={typed} />
          </>,
        );
    } catch (err) {
      return errorsOf(err, fields, {
        at: inRecord,
        mismatch: "The record does not match the collection's fields",
        failed: "Could not save the record",
      });
    }
    onDone();
    return undefined;
  });

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        {fields.map((field) =>
          saved && field.key === key ? (
            // The key names the record: an edit keeps it. `contents`, so it lays out as the group's own.
            <fieldset key={field.key} disabled className="contents">
              <FieldView form={form} field={field} path={[field.key]} />
            </fieldset>
          ) : (
            <FieldView key={field.key} form={form} field={field} path={[field.key]} />
          ),
        )}
        {staged && <Notice>{STAGED_FIRST}, in the grid's bar.</Notice>}
        <FormFoot form={form}>
          {(submitting) => (
            <>
              <Button type="submit" disabled={submitting || staged}>
                {submitting ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <FloppyDiskIcon aria-hidden="true" data-icon="inline-start" />
                )}
                {submitting ? "Saving…" : "Save"}
              </Button>
              {saved && (
                <DeleteRecord
                  records={records}
                  recordKey={saved.key}
                  disabled={submitting || staged}
                  onDeleted={onDone}
                />
              )}
            </>
          )}
        </FormFoot>
      </FieldGroup>
    </form>
  );
}

/** Delete, and the dialog that asks before it deletes the record from `records`; a denial shows in the dialog. */
function DeleteRecord({
  records,
  recordKey,
  disabled,
  onDeleted,
}: {
  records: RecordsView["collection"];
  recordKey: string;
  /** While a save is under way: one write at a time. */
  disabled: boolean;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  // What the dialog shows while the delete is under way, or once it failed (a denial stays in it).
  const call = useMutation({
    mutationFn: () => records.delete(recordKey).when("settled"),
    onSuccess: (tx) => {
      // A held delete leaves the record, marked as waiting, until its run ends: its toast said so.
      if (savedIn(tx, recordKey) === null) toast.success(`Deleted ${recordKey}`);
      setOpen(false);
      onDeleted();
    },
  });
  return (
    <>
      <Button type="button" variant="outline" className="ml-auto" disabled={disabled} onClick={() => setOpen(true)}>
        <TrashIcon aria-hidden="true" data-icon="inline-start" />
        Delete
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !call.isPending) {
            call.reset();
            setOpen(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {recordKey}?</DialogTitle>
            <DialogDescription>
              The record leaves the collection; the ledger keeps the call. Nothing else changes.
            </DialogDescription>
          </DialogHeader>
          {call.isError && <Notice variant="destructive">{errorMessage(call.error)}</Notice>}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={call.isPending} />}>
              Cancel
            </DialogClose>
            <Button type="button" variant="destructive" disabled={call.isPending} onClick={() => call.mutate()}>
              {call.isPending && <Spinner data-icon="inline-start" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
