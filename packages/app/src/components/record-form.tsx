import type { CollectionEntry } from "@sanoma-ai/workflows/describe";
import { CALL_WORKFLOW, errorMessage, type Saved } from "@sanoma-ai/workflows/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SaveIcon, Trash2Icon } from "lucide-react";
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
import { errorBodyOf } from "../api.ts";
import type { UntypedApi } from "../api-client.ts";
import { buildInput, fieldsOf, initialValues } from "../form/schema.ts";
import { errorsOf, FieldView, FormFoot, useSchemaForm } from "../form/start-form.tsx";
import { DATA_KEY, runLink } from "../queries.ts";
import { api } from "../site.ts";
import { Notice } from "./common.tsx";

// A collection's record form: one form, drawn from the record's JSON Schema as the start form is
// from a workflow's input, to add a record or edit one; and Delete. Every call is the collection's
// operation, `data.<name>.save` or `.delete`, made through `api` as the person.

/** A call the form makes: an operation of the collection and its input. */
type RecordCall = { op: "save" | "delete"; input: unknown };

/**
 * Calls the collection's `save` or `delete` through `api` (a new id each), as the person asking,
 * and refreshes the collection's records once it is made. A failure is the caller's to show.
 */
function useRecordCall(name: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ op, input }: RecordCall) => (api as UntypedApi).data[name][op](input) as Promise<unknown>,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [...DATA_KEY, name] }),
  });
}

/**
 * When `err` is a call the policy holds for an approval, says so with a toast linking to the run
 * of the built-in `call` workflow that makes it once approved, and answers true.
 */
function toastIfHeld(err: unknown): boolean {
  const body = errorBodyOf(err);
  if (body?.code !== "approval_pending" || !body.runId) return false;
  toast.info("Held for approval", {
    description: (
      <Link {...runLink({ workflow: CALL_WORKFLOW, runId: body.runId })} className="underline underline-offset-4">
        Open the run
      </Link>
    ),
  });
  return true;
}

/** An issue's path in a save's input (`record.<field>`), as the form's. */
const inRecord = (path: (string | number)[]) => (path[0] === "record" ? path.slice(1) : path);

/**
 * The record form: a new record's (`saved` none), its people filled in with `actor`, whoever is
 * asking; or `saved`'s, its key read-only, with Delete. Save answers by `onDone` once saved or
 * held for an approval (said with a toast linking to its run); a denial and what the fields
 * refuse show on the form.
 */
export function RecordForm({
  collection: { name, key, record },
  saved,
  actor,
  onDone,
}: {
  collection: CollectionEntry;
  saved?: Saved | undefined;
  actor: string | null | undefined;
  onDone: () => void;
}) {
  const fields = useMemo(() => fieldsOf(record) ?? [], [record]);
  const call = useRecordCall(name);
  const defaultValues = useMemo(() => {
    if (saved) return initialValues(fields, saved.record);
    const people = actor ? fields.filter((f) => f.kind === "person").map((f) => [f.key, actor]) : [];
    return initialValues(fields, Object.fromEntries(people));
  }, [fields, saved, actor]);
  const form = useSchemaForm(defaultValues, async (values) => {
    const built = buildInput(fields, values);
    if (Object.keys(built.errors).length) return { fields: built.errors };
    const input = { record: built.input };
    try {
      await call.mutateAsync({ op: "save", input });
    } catch (err) {
      if (toastIfHeld(err)) {
        onDone();
        return undefined;
      }
      return errorsOf(err, fields, {
        at: inRecord,
        mismatch: "The record does not match the collection's fields",
        failed: "Could not save the record",
      });
    }
    toast.success(`Saved ${String(input.record[key] ?? "")}`);
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
        <FormFoot form={form}>
          {(submitting) => (
            <>
              <Button type="submit" disabled={submitting}>
                {submitting ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
                {submitting ? "Saving…" : "Save"}
              </Button>
              {saved && <DeleteRecord name={name} recordKey={saved.key} onDeleted={onDone} />}
            </>
          )}
        </FormFoot>
      </FieldGroup>
    </form>
  );
}

/** Delete, and the dialog that asks before it calls `data.<name>.delete`; a denial shows in the dialog. */
function DeleteRecord({ name, recordKey, onDeleted }: { name: string; recordKey: string; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const call = useRecordCall(name);
  const remove = async () => {
    try {
      await call.mutateAsync({ op: "delete", input: { key: recordKey } });
      toast.success(`Deleted ${recordKey}`);
    } catch (err) {
      // A denial, or any other failure, stays in the dialog.
      if (!toastIfHeld(err)) return;
      call.reset();
    }
    setOpen(false);
    onDeleted();
  };
  return (
    <>
      <Button type="button" variant="outline" className="ml-auto" onClick={() => setOpen(true)}>
        <Trash2Icon data-icon="inline-start" />
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
            <Button type="button" variant="destructive" disabled={call.isPending} onClick={() => void remove()}>
              {call.isPending && <Spinner data-icon="inline-start" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
