import type { WorkflowEntry } from "@sanoma-ai/workflows/describe";
import { useForm } from "@tanstack/react-form";
import { useHydrated } from "@tanstack/react-router";
import { PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type ComponentProps, type ReactNode, useMemo } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Checkbox } from "#/components/ui/checkbox.tsx";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { errorMessage } from "@sanoma-ai/workflows/shared";
import { errorBodyOf, type ScenarioEntry, type StartRunRequest, type StartRunResponse } from "../api.ts";
import { Notice, TipButton } from "../components/common.tsx";
import { useStartRun } from "../queries.ts";
import {
  buildInput,
  type Field as SchemaField,
  fieldsOf,
  fromLocalInput,
  initialValue,
  initialValues,
  issueTarget,
  issueText,
  pathName,
  type ScalarField,
  toLocalInput,
} from "./schema.ts";

/** When the input is not an object with properties, the whole input is one JSON field. */
const WHOLE = "input";

/**
 * A form for a workflow's input, from its JSON Schema. Starts the run and opens it, or, with
 * `onStarted`, hands it the run and stays. With `scenario`, it shows the scenario's input,
 * read-only, and starts a sandbox run of it: the server takes the input from the scenario, not
 * from the form.
 */
export function StartForm({
  workflow,
  scenario,
  onStarted,
}: {
  workflow: WorkflowEntry;
  scenario?: ScenarioEntry;
  onStarted?: (run: StartRunResponse) => void;
}) {
  const { fields, whole } = useMemo(() => {
    const read = fieldsOf(workflow.input);
    const all: SchemaField[] = read ?? [
      { key: WHOLE, label: "Input (JSON)", kind: "json", required: true, default: {} },
    ];
    return { fields: all, whole: !read };
  }, [workflow.input]);
  const form = useStartForm(workflow.name, fields, whole, scenario, onStarted);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        {/* A scenario's input is shown, not entered: the browser disables every control inside,
            and Add and Remove hide. `contents`, so the fields lay out as the group's own. */}
        <fieldset disabled={scenario !== undefined} className="group/ro contents">
          {fields.map((field) => (
            <FieldView key={field.key} form={form} field={field} path={[field.key]} />
          ))}
        </fieldset>
        <FormFoot form={form}>
          {(submitting) => (
            <Button type="submit" disabled={submitting}>
              {submitting ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
              {submitting ? "Starting…" : scenario ? "Start sandbox run" : "Start run"}
            </Button>
          )}
        </FormFoot>
      </FieldGroup>
    </form>
  );
}

/** What a form over schema fields holds, by field name. */
export type FormValues = Record<string, any>;

/** What a form's submit answers: nothing once it is done, else the form's message and each field's. */
export type SubmitErrors = { form?: string | undefined; fields: Record<string, string> } | undefined;

/**
 * A TanStack Form over schema fields, from `defaultValues`, whose submit is `submit`: the call is
 * the validation, as the server checks what it is sent, and the errors it answers land on the
 * fields (`errorsOf`). The start form's and the record form's.
 */
export function useSchemaForm(defaultValues: FormValues, submit: (values: FormValues) => Promise<SubmitErrors>) {
  return useForm({ defaultValues, validators: { onSubmitAsync: ({ value }) => submit(value) } });
}

export type SchemaFormApi = ReturnType<typeof useSchemaForm>;

/**
 * A refused call's errors, for a form over `fields`: the server's issues on the fields they name
 * (`at` maps an issue's path to the form's), the rest as the form's message, or `mismatch` when
 * every issue found a field none shows; any other failure's message, `failed` when it has none.
 */
export function errorsOf(
  err: unknown,
  fields: SchemaField[],
  {
    at = (path) => path,
    mismatch,
    failed,
  }: { at?: (path: (string | number)[]) => (string | number)[]; mismatch: string; failed: string },
): NonNullable<SubmitErrors> {
  const body = errorBodyOf(err);
  if (!body?.issues?.length) {
    // Not the server's answer (the network, a bug): keep the raw value for whoever debugs it.
    if (!body) console.error(`sanoma app: ${failed}:`, err);
    // `fields` must be there, even empty, for the form to read `form` as its own error.
    return { form: errorMessage(err).trim() || `${failed}, and no reason was given`, fields: {} };
  }
  const byField: Record<string, string> = {};
  const rest: string[] = [];
  for (const issue of body.issues) {
    const target = issueTarget(fields, at(issue.path), issue.message);
    if (target) byField[target.name] ??= target.message;
    else rest.push(issueText(issue));
  }
  // A form-level message only for what no field shows.
  const placed = Object.keys(byField).length > 0;
  return { form: rest.length ? rest.join("; ") : placed ? undefined : mismatch, fields: byField };
}

/** A form's foot: the message no field shows, then its buttons, `children` (told while it submits). */
export function FormFoot({ form, children }: { form: SchemaFormApi; children: (submitting: boolean) => ReactNode }) {
  return (
    <form.Subscribe selector={(s) => [s.errorMap.onSubmit, s.isSubmitting] as const}>
      {([error, submitting]) => (
        <>
          {typeof error === "string" && error && <Notice variant="destructive">{error}</Notice>}
          <Field orientation="horizontal">{children(submitting)}</Field>
        </>
      )}
    </form.Subscribe>
  );
}

function useStartForm(
  workflow: string,
  fields: SchemaField[],
  whole: boolean,
  scenario?: ScenarioEntry,
  onStarted?: (run: StartRunResponse) => void,
) {
  const start = useStartRun({ navigate: !onStarted });
  const defaultValues = useMemo(() => {
    const input = scenario && (whole ? { [WHOLE]: scenario.input } : scenario.input);
    return initialValues(fields, input) as FormValues;
  }, [fields, whole, scenario]);
  // Starting the run is the validation: the server checks the input against the workflow's zod
  // schema and answers with its issues, which land on the fields they name. Once it has started,
  // `useStartRun` moves the page on to the run, or `onStarted` has it.
  const submit = async (request: StartRunRequest): Promise<SubmitErrors> => {
    let started: StartRunResponse;
    try {
      started = await start.mutateAsync(request);
    } catch (err) {
      return errorsOf(err, fields, {
        at: (path) => (whole ? [WHOLE, ...path] : path),
        mismatch: "The input does not match the workflow's schema",
        failed: "Could not start the run",
      });
    }
    // Outside the try: the run has started, so a throw here is not a failure to start it.
    onStarted?.(started);
    return undefined;
  };
  return useSchemaForm(defaultValues, async (value) => {
    // A sandbox run takes its input from the scenario, on the server.
    if (scenario) return submit({ scenario: scenario.name });
    const built = buildInput(fields, value);
    if (Object.keys(built.errors).length) return { fields: built.errors };
    return submit({ workflow, input: whole ? built.input[WHOLE] : built.input });
  });
}

/** One field, by its kind: a control, a set of controls, or a list with Add and Remove (hidden while read-only). */
export function FieldView({
  form,
  field,
  path,
}: {
  form: SchemaFormApi;
  field: SchemaField;
  path: (string | number)[];
}) {
  const name = pathName(path);
  if (field.kind === "object") {
    return (
      <FieldSet>
        <FieldLegend>
          <LabelText field={field} />
        </FieldLegend>
        {field.description && <FieldDescription>{field.description}</FieldDescription>}
        <FieldGroup>
          {field.fields.map((sub) => (
            <FieldView key={sub.key} form={form} field={sub} path={[...path, sub.key]} />
          ))}
        </FieldGroup>
      </FieldSet>
    );
  }
  if (field.kind === "array") {
    const item = field.item;
    return (
      <form.Field name={name} mode="array">
        {(f) => (
          <FieldSet data-invalid={f.state.meta.errors.length ? true : undefined}>
            <FieldLegend>
              <LabelText field={field} />
            </FieldLegend>
            {field.description && <FieldDescription>{field.description}</FieldDescription>}
            <FieldGroup>
              {(f.state.value as unknown[]).map((_, i) => {
                const label = `${field.label} ${i + 1}`;
                const remove = `Remove ${label}`;
                return (
                  <Field key={i} orientation="horizontal" className="items-start">
                    <FieldContent>
                      <FieldView form={form} field={{ ...item, label }} path={[...path, i]} />
                    </FieldContent>
                    <TipButton
                      tip={remove}
                      type="button"
                      className="group-disabled/ro:hidden"
                      onClick={() => f.removeValue(i)}
                    >
                      <Trash2Icon />
                    </TipButton>
                  </Field>
                );
              })}
              <Field orientation="horizontal" className="group-disabled/ro:hidden">
                <Button type="button" variant="outline" onClick={() => f.pushValue(initialValue(item, item.default))}>
                  <PlusIcon data-icon="inline-start" />
                  Add {item.kind === "object" ? "an item" : "a value"}
                </Button>
              </Field>
            </FieldGroup>
            <Errors errors={f.state.meta.errors} />
          </FieldSet>
        )}
      </form.Field>
    );
  }
  return <ScalarView form={form} field={field} name={name} />;
}

/** The text-like kinds, each one <Input>. A person is their id, as text. */
const INPUT_TYPE = {
  string: { type: "text" },
  person: { type: "text", autoComplete: "off" },
  number: { type: "number", step: "any" },
  integer: { type: "number", step: 1 },
} as const;

/** A date alone, as a date input holds it. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function ScalarView({ form, field, name }: { form: SchemaFormApi; field: ScalarField; name: string }) {
  const id = `field-${name}`;
  return (
    <form.Field name={name}>
      {(f) => {
        const value = f.state.value as string | boolean | undefined;
        const text = typeof value === "string" ? value : "";
        const invalid = f.state.meta.errors.length ? true : undefined;
        const onText = (e: { target: { value: string } }) => f.handleChange(e.target.value);
        const common = { id, "aria-invalid": invalid, onBlur: f.handleBlur };
        const description = (
          <>
            {field.description && <FieldDescription>{field.description}</FieldDescription>}
            {field.kind === "json" && <FieldDescription>Entered as JSON.</FieldDescription>}
          </>
        );

        if (field.kind === "boolean") {
          return (
            <Field orientation="horizontal" data-invalid={invalid}>
              <Checkbox
                id={id}
                aria-invalid={invalid}
                checked={value === true}
                onCheckedChange={(checked) => f.handleChange(checked === true)}
              />
              <FieldContent>
                <FieldLabel htmlFor={id}>
                  <LabelText field={field} />
                </FieldLabel>
                {description}
                <Errors errors={f.state.meta.errors} />
              </FieldContent>
            </Field>
          );
        }

        let control;
        switch (field.kind) {
          case "string":
          case "person":
          case "number":
          case "integer":
            control = <Input {...common} {...INPUT_TYPE[field.kind]} value={text} onChange={onText} />;
            break;
          case "date":
            // A date and time a workflow saved keeps its time: it shows as one.
            control =
              text === "" || DATE_ONLY.test(text) ? (
                <Input {...common} type="date" value={text} onChange={onText} />
              ) : (
                <DateTimeInput {...common} value={text} onChange={f.handleChange} />
              );
            break;
          case "datetime":
            control = <DateTimeInput {...common} value={text} onChange={f.handleChange} />;
            break;
          case "enum":
            control = (
              <NativeSelect {...common} name={name} className="w-full" value={text} onChange={onText}>
                <NativeSelectOption value="" disabled={field.required}>
                  {field.required ? "Choose…" : "(leave out)"}
                </NativeSelectOption>
                {(field.options ?? []).map((option, i) => (
                  <NativeSelectOption key={String(option)} value={String(i)}>
                    {String(option)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            );
            break;
          case "json":
            control = (
              <Textarea {...common} className="font-mono" rows={4} placeholder="JSON" value={text} onChange={onText} />
            );
            break;
        }
        return (
          <Field data-invalid={invalid}>
            <FieldLabel htmlFor={id}>
              <LabelText field={field} />
            </FieldLabel>
            {control}
            {description}
            <Errors errors={f.state.meta.errors} />
          </Field>
        );
      }}
    </form.Field>
  );
}

/**
 * A date and time, held as ISO text: a `datetime-local` control in the browser's time zone once
 * the page has hydrated. The server knows no browser's zone, so it, and the browser until then,
 * render the ISO text itself: the same markup on both, whatever the zones.
 */
function DateTimeInput({
  value,
  onChange,
  ...props
}: Omit<ComponentProps<typeof Input>, "type" | "value" | "onChange"> & {
  value: string;
  onChange: (iso: string) => void;
}) {
  const hydrated = useHydrated();
  if (!hydrated) return <Input {...props} type="text" value={value} readOnly />;
  return (
    <Input
      {...props}
      type="datetime-local"
      value={toLocalInput(value)}
      // An incomplete date and time reads as none.
      onChange={(e) => onChange(fromLocalInput(e.target.value) ?? "")}
    />
  );
}

function LabelText({ field }: { field: SchemaField }) {
  return (
    <>
      {field.label}
      {field.required ? (
        <>
          <span aria-hidden className="text-destructive">
            *
          </span>
          <span className="sr-only">(required)</span>
        </>
      ) : (
        <span className="font-normal text-muted-foreground">(optional)</span>
      )}
    </>
  );
}

/** The field's errors, under it: the form's own checks and the server's issues, as strings. */
function Errors({ errors }: { errors: unknown[] }) {
  return <FieldError errors={errors.filter(Boolean).map((e) => ({ message: String(e) }))} />;
}
