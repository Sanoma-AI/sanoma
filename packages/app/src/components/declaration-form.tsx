import type { DeclaredResource, ResourceTypeEntry } from "@sanoma-ai/workflows/describe";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { FloppyDiskIcon } from "@phosphor-icons/react/dist/csr/FloppyDisk";
import { useMemo, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { FieldGroup } from "#/components/ui/field.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { ApiError, type PatchRequest, type PatchResponse } from "../api.ts";
import { buildInput, type Field, fieldsOf, initialValues } from "../form/schema.ts";
import { errorsOf, FieldView, FormFoot, type SubmitErrors, useSchemaForm } from "../form/start-form.tsx";
import { patchFn } from "../functions.ts";
import { configQuery, isPeople, sourceQuery } from "../queries.ts";
import { Notice } from "./kit.tsx";

// A declaration's form: its literal fields, drawn from its type's JSON Schema as a record form is
// from a collection's, prefilled with what its data file declares, and Save writing the fields it
// changed into the file (`patchFn`): a change for review with a remote, a commit without one. The
// writer refuses a field the file computes (409, with its reason): that field turns read-only,
// with the reason under it, and stays the code's to change. A person's, agent's or group's
// identity is read-only wherever the form shows (People, Hosting's Edit).

/** The fields a form sets of a resource of `type`: its schema's, less those only the vendor sets or never reads back. */
export function declarationFields(type: ResourceTypeEntry | undefined): Field[] | undefined {
  const fields = type && fieldsOf(type.schema);
  if (!fields) return undefined;
  const hidden = new Set([...type.fields.vendorOwned, ...type.fields.writeOnly]);
  return fields.filter((f) => !hidden.has(f.key));
}

/** The field that holds `path` (a dotted path, as the writer and `refs` name one): its top-level key. */
const fieldAt = (fields: Field[], path: string) =>
  fields.find((f) => f.key === path || path.startsWith(`${f.key}.`))?.key;

/** Why a field that names another declared resource is not the form's to change. */
const NAMES_A_RESOURCE = "Names another declared resource: change it in the file.";

/** Why the form leaves who someone is to the file: the policy and the groups name them by it. */
const IDENTITY = "Who it is to the policy and to the groups: change it in the file.";

/**
 * The form over `resource`'s literal fields, by its `type`'s schema, a person's, agent's or
 * group's identity (the field `find` reads it by: `id`, or a group's `name`) shown but not set
 * here. Save sends only the fields that differ from what the file declares; what it answers shows
 * under the form, a change linking to its review.
 */
export function DeclarationForm({
  resource,
  type,
}: {
  resource: Pick<DeclaredResource, "at" | "file" | "desired" | "refs" | "vendor" | "type">;
  type: ResourceTypeEntry | undefined;
}) {
  const fields = useMemo(() => declarationFields(type), [type]);
  if (!fields?.length) {
    return <Notice>Its type has no fields this form can show: change it in its file.</Notice>;
  }
  const identity = isPeople(resource) ? type?.identity?.split(":")[0] : undefined;
  return <SchemaDeclarationForm resource={resource} fields={fields} identity={identity} />;
}

function SchemaDeclarationForm({
  resource: { at, file, desired, refs },
  fields,
  identity,
}: {
  resource: Pick<DeclaredResource, "at" | "file" | "desired" | "refs">;
  fields: Field[];
  /** The field shown read-only as who the resource is. */
  identity: string | undefined;
}) {
  const queryClient = useQueryClient();
  const patch = useServerFn(patchFn);
  const defaultValues = useMemo(() => initialValues(fields, desired), [fields, desired]);
  /** What the file declares, as the form reads its fields: what a Save compares against, moved on by each one. */
  const [declared, setDeclared] = useState(() => buildInput(fields, defaultValues).input);
  /** The fields the writer refused, by key, each with its reason. */
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<PatchResponse>();
  const readOnly = useMemo(() => {
    const why: Record<string, string> = identity ? { [identity]: IDENTITY } : {};
    for (const path of Object.keys(refs)) {
      const key = fieldAt(fields, path);
      if (key) why[key] ??= NAMES_A_RESOURCE;
    }
    return { ...why, ...refused };
  }, [identity, refs, fields, refused]);

  const form = useSchemaForm(defaultValues, async (values): Promise<SubmitErrors> => {
    setSaved(undefined);
    const built = buildInput(fields, values);
    if (Object.keys(built.errors).length) return { fields: built.errors };
    const changed: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    for (const { key } of fields) {
      if (key in readOnly) continue;
      const now = built.input[key];
      if (JSON.stringify(now) === JSON.stringify(declared[key])) continue;
      // The writer sets values and removes none: an emptied field is the code's to remove.
      if (now === undefined) errors[key] = "Save sets fields and removes none: remove it in the file.";
      else changed[key] = now;
    }
    if (Object.keys(errors).length) return { fields: errors };
    if (!Object.keys(changed).length) return { form: "Nothing has changed.", fields: {} };
    try {
      // What `buildInput` reads from the form is JSON.
      const answer = await patch({ data: { at, fields: changed as PatchRequest["fields"] } });
      setDeclared((prev) => ({ ...prev, ...changed }));
      setSaved(answer);
      // Written in the checkout: the file, and the description the app makes again from it.
      if ("file" in answer)
        await Promise.all(
          [sourceQuery(file).queryKey, configQuery().queryKey].map((queryKey) =>
            queryClient.invalidateQueries({ queryKey }),
          ),
        );
      return undefined;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const key = err.body.field === undefined ? undefined : fieldAt(fields, err.body.field);
        // Not a field's (the declaration, or the file not read or written this time): said, and Save stays.
        if (!key) return { form: err.body.error, fields: {} };
        // Read-only from now on, with the reason under it, and back to what the file declares.
        setRefused((prev) => ({ ...prev, [key]: err.body.error }));
        form.setFieldValue(key, defaultValues[key]);
        return { form: `Not saved: ${err.body.error}.`, fields: {} };
      }
      return errorsOf(err, fields, {
        mismatch: "The fields do not match the resource's type",
        failed: "Could not save the declaration",
      });
    }
  });

  // Nothing in it the form's to set (a group: its name and its members).
  const locked = fields.every((f) => f.key in readOnly);
  return (
    <form
      noValidate
      aria-label={`Declaration of ${at.export}`}
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        <fieldset disabled={locked} className="group/ro contents">
          {fields.map((field) =>
            field.key in readOnly ? (
              // Shown as declared, with why the form leaves it. `contents`, so it lays out as the group's own.
              <fieldset key={field.key} disabled className="group/ro contents">
                <FieldView form={form} field={{ ...field, description: readOnly[field.key] }} path={[field.key]} />
              </fieldset>
            ) : (
              <FieldView key={field.key} form={form} field={field} path={[field.key]} />
            ),
          )}
        </fieldset>
        {saved && <SavedNotice saved={saved} />}
        <FormFoot form={form}>
          {(submitting) => (
            <Button type="submit" disabled={submitting || locked}>
              {submitting ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <FloppyDiskIcon aria-hidden="true" data-icon="inline-start" />
              )}
              {submitting ? "Saving…" : "Save"}
            </Button>
          )}
        </FormFoot>
      </FieldGroup>
    </form>
  );
}

/** Where a Save landed: a change for review, linking to it, or the file written and its commit. */
function SavedNotice({ saved }: { saved: PatchResponse }) {
  if ("change" in saved) {
    return (
      <Notice>
        Saved as a change.{" "}
        <Link to="/changes/$id" params={{ id: saved.change }} className="underline underline-offset-4">
          Open its review
        </Link>
      </Notice>
    );
  }
  return (
    <Notice>
      Saved to <code>{saved.file}</code>
      {saved.revision ? (
        <>
          , committed as <code title={saved.revision}>{saved.revision.slice(0, 7)}</code>
        </>
      ) : (
        ", not committed: the app has no repository"
      )}
      .
    </Notice>
  );
}
