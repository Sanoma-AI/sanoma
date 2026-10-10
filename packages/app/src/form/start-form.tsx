import type { WorkflowEntry } from "@sanoma/workflows/describe";
import { useForm } from "@tanstack/react-form";
import { PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo } from "react";
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
import { errorMessage } from "@sanoma/workflows/shared";
import { errorBodyOf, type ScenarioEntry, type StartRunRequest } from "../api.ts";
import { Notice, Tip } from "../components/common.tsx";
import { useStartRun } from "../queries.ts";
import {
  buildInput,
  type Field as SchemaField,
  fieldsOf,
  initialValue,
  initialValues,
  issueTarget,
  pathName,
  type ScalarField,
  valuesFrom,
} from "./schema.ts";

/** When the input is not an object with properties, the whole input is one JSON field. */
const WHOLE = "input";

/**
 * A form for a workflow's input, from its JSON Schema. Starts the run and opens it. With
 * `scenario`, it shows the scenario's input, read-only, and starts a sandbox run of it: the
 * server takes the input from the scenario, not from the form.
 */
export function StartForm({ workflow, scenario }: { workflow: WorkflowEntry; scenario?: ScenarioEntry }) {
  const { fields, whole } = useMemo(() => {
    const read = fieldsOf(workflow.input);
    const all: SchemaField[] = read ?? [
      { key: WHOLE, label: "Input (JSON)", kind: "json", required: true, default: {} },
    ];
    return { fields: all, whole: !read };
  }, [workflow.input]);
  const form = useStartForm(workflow.name, fields, whole, scenario);
  const disabled = scenario !== undefined;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        {fields.map((field) => (
          <FieldView key={field.key} form={form} field={field} path={[field.key]} disabled={disabled} />
        ))}
        <form.Subscribe selector={(s) => [s.errorMap.onSubmit, s.isSubmitting] as const}>
          {([error, submitting]) => (
            <>
              {typeof error === "string" && error && <Notice variant="destructive">{error}</Notice>}
              <Field orientation="horizontal">
                <Button type="submit" disabled={submitting}>
                  {submitting ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
                  {submitting ? "Starting…" : disabled ? "Start sandbox run" : "Start run"}
                </Button>
              </Field>
            </>
          )}
        </form.Subscribe>
      </FieldGroup>
    </form>
  );
}

type FormValues = Record<string, any>;

function useStartForm(workflow: string, fields: SchemaField[], whole: boolean, scenario?: ScenarioEntry) {
  const start = useStartRun();
  const defaultValues = useMemo(
    () =>
      (scenario
        ? valuesFrom(fields, whole ? { [WHOLE]: scenario.input } : scenario.input)
        : initialValues(fields)) as FormValues,
    [fields, whole, scenario],
  );
  return useForm({
    defaultValues,
    validators: {
      // Starting the run is the validation: the server checks the input against the workflow's
      // zod schema and answers with its issues, which land on the fields they name. Once it
      // has started, `useStartRun` moves the page on to the run.
      onSubmitAsync: async ({ value }) => {
        // A sandbox run takes its input from the scenario, on the server.
        let request: StartRunRequest;
        if (scenario) request = { scenario: scenario.name };
        else {
          const built = buildInput(fields, value);
          if (Object.keys(built.errors).length) return { fields: built.errors };
          request = { workflow, input: whole ? built.input[WHOLE] : built.input };
        }
        try {
          await start.mutateAsync(request);
          return undefined;
        } catch (err) {
          const body = errorBodyOf(err);
          if (!body?.issues?.length) {
            // Not the server's answer (the network, a bug): keep the raw value for whoever debugs it.
            if (!body) console.error("sanoma app: starting the run failed:", err);
            const message = errorMessage(err).trim() || "Could not start the run, and no reason was given";
            // `fields` must be there, even empty, for the form to read `form` as its own error.
            return { form: message, fields: {} };
          }
          const byField: Record<string, string> = {};
          const rest: string[] = [];
          for (const issue of body.issues) {
            const target = issueTarget(fields, whole ? [WHOLE, ...issue.path] : issue.path, issue.message);
            if (target) byField[target.name] ??= target.message;
            else rest.push(issue.path.length ? `${pathName(issue.path)}: ${issue.message}` : issue.message);
          }
          // A form-level message only for what no field shows.
          const placed = Object.keys(byField).length > 0;
          const message = rest.length
            ? rest.join("; ")
            : placed
              ? undefined
              : "The input does not match the workflow's schema";
          return { form: message, fields: byField };
        }
      },
    },
  });
}

type StartFormApi = ReturnType<typeof useStartForm>;

interface FieldProps {
  form: StartFormApi;
  /** Read-only: a scenario's input, shown, not entered. */
  disabled: boolean;
}

/** One field, by its kind: a control, a set of controls, or a list with Add and Remove (unless disabled). */
function FieldView({ form, field, path, disabled }: FieldProps & { field: SchemaField; path: (string | number)[] }) {
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
            <FieldView key={sub.key} form={form} field={sub} path={[...path, sub.key]} disabled={disabled} />
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
                      <FieldView form={form} field={{ ...item, label }} path={[...path, i]} disabled={disabled} />
                    </FieldContent>
                    {/* The button's name says it already: hidden from the tooltip's description, so it is not read twice. */}
                    {!disabled && (
                      <Tip tip={<span aria-hidden>{remove}</span>}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => f.removeValue(i)}
                          aria-label={remove}
                        >
                          <Trash2Icon />
                        </Button>
                      </Tip>
                    )}
                  </Field>
                );
              })}
              {!disabled && (
                <Field orientation="horizontal">
                  <Button type="button" variant="outline" onClick={() => f.pushValue(initialValue(item, item.default))}>
                    <PlusIcon data-icon="inline-start" />
                    Add {item.kind === "object" ? "an item" : "a value"}
                  </Button>
                </Field>
              )}
            </FieldGroup>
            <Errors errors={f.state.meta.errors} />
          </FieldSet>
        )}
      </form.Field>
    );
  }
  return <ScalarView form={form} field={field} name={name} disabled={disabled} />;
}

/** The text-like kinds, each one <Input>. */
const INPUT_TYPE = {
  string: { type: "text" },
  datetime: { type: "datetime-local" },
  number: { type: "number", step: "any" },
  integer: { type: "number", step: 1 },
} as const;

function ScalarView({ form, field, name, disabled }: FieldProps & { field: ScalarField; name: string }) {
  const id = `field-${name}`;
  return (
    <form.Field name={name}>
      {(f) => {
        const value = f.state.value as string | boolean | undefined;
        const text = typeof value === "string" ? value : "";
        const invalid = f.state.meta.errors.length ? true : undefined;
        const onText = (e: { target: { value: string } }) => f.handleChange(e.target.value);
        const common = { id, "aria-invalid": invalid, onBlur: f.handleBlur, disabled };
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
                disabled={disabled}
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
          case "datetime":
          case "number":
          case "integer": {
            // A read-only date-time is its ISO text (see `valuesFrom`), not a local one.
            const type = disabled && field.kind === "datetime" ? INPUT_TYPE.string : INPUT_TYPE[field.kind];
            control = <Input {...common} {...type} value={text} onChange={onText} />;
            break;
          }
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
