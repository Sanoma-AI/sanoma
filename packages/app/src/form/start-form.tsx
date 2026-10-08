import type { WorkflowEntry } from "@sanoma/workflows";
import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
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
import { errorBodyOf } from "../api.ts";
import { Notice } from "../components/common.tsx";
import { startRunFn } from "../functions.ts";
import {
  buildInput,
  type Field as SchemaField,
  fieldsOf,
  initialValue,
  initialValues,
  issueTarget,
  pathName,
  type ScalarField,
} from "./schema.ts";

/** When the input is not an object with properties, the whole input is one JSON field. */
const WHOLE = "input";

/** A form for a workflow's input, from its JSON Schema. Starts the run and opens it. */
export function StartForm({ workflow }: { workflow: WorkflowEntry }) {
  const { fields, whole } = useMemo(() => {
    const read = fieldsOf(workflow.input);
    const all: SchemaField[] = read ?? [
      { key: WHOLE, label: "Input (JSON)", kind: "json", required: true, default: {} },
    ];
    return { fields: all, whole: !read };
  }, [workflow.input]);
  const form = useStartForm(workflow.name, fields, whole);

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
          <FieldView key={field.key} form={form} field={field} path={[field.key]} />
        ))}
        <form.Subscribe selector={(s) => [s.errorMap.onSubmit, s.isSubmitting] as const}>
          {([error, submitting]) => (
            <>
              {typeof error === "string" && error && <Notice tone="bad">{error}</Notice>}
              <Field orientation="horizontal">
                <Button type="submit" disabled={submitting}>
                  {submitting ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
                  {submitting ? "Starting…" : `Start ${workflow.name}`}
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

function useStartForm(workflow: string, fields: SchemaField[], whole: boolean) {
  const start = useServerFn(startRunFn);
  const navigate = useNavigate();
  const defaultValues = useMemo(() => initialValues(fields) as FormValues, [fields]);
  return useForm({
    defaultValues,
    validators: {
      // Starting the run is the validation: the server checks the input against the workflow's
      // zod schema and answers with its issues, which land on the fields they name. Once it
      // has started, the page moves on to the run.
      onSubmitAsync: async ({ value }) => {
        const built = buildInput(fields, value);
        if (Object.keys(built.errors).length) return { fields: built.errors };
        let runId: string;
        try {
          ({ runId } = await start({ data: { workflow, input: whole ? built.input[WHOLE] : built.input } }));
        } catch (err) {
          const body = errorBodyOf(err);
          if (!body?.issues?.length) {
            const message = body?.error ?? (err as Error).message;
            toast.error(`Could not start ${workflow}`, { description: message });
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
          const message = rest.join("; ") || "The input does not match the workflow's schema";
          toast.error(`Could not start ${workflow}`, { description: message });
          return { form: message, fields: byField };
        }
        toast.success(`Started ${workflow}`);
        await navigate({ to: "/runs/$id", params: { id: runId } });
        return undefined;
      },
    },
  });
}

type StartFormApi = ReturnType<typeof useStartForm>;

/** One field, by its kind: a control, a set of controls, or a list with Add and Remove. */
function FieldView({ form, field, path }: { form: StartFormApi; field: SchemaField; path: (string | number)[] }) {
  const name = pathName(path);
  if (field.kind === "object") {
    return (
      <FieldSet>
        <FieldLegend>
          <Label field={field} />
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
              <Label field={field} />
            </FieldLegend>
            {field.description && <FieldDescription>{field.description}</FieldDescription>}
            <FieldGroup>
              {(f.state.value as unknown[]).map((_, i) => (
                <Field key={i} orientation="horizontal" className="items-start">
                  <FieldContent>
                    <FieldView form={form} field={{ ...item, label: `${field.label} ${i + 1}` }} path={[...path, i]} />
                  </FieldContent>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => f.removeValue(i)}
                    aria-label={`Remove ${field.label} ${i + 1}`}
                  >
                    <Trash2Icon />
                  </Button>
                </Field>
              ))}
              <Field orientation="horizontal">
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

function ScalarView({ form, field, name }: { form: StartFormApi; field: ScalarField; name: string }) {
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
                  <Label field={field} />
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
            control = <Input {...common} type="text" value={text} onChange={onText} />;
            break;
          case "datetime":
            control = <Input {...common} type="datetime-local" value={text} onChange={onText} />;
            break;
          case "number":
          case "integer":
            control = (
              <Input
                {...common}
                type="number"
                step={field.kind === "integer" ? 1 : "any"}
                value={text}
                onChange={onText}
              />
            );
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
              <Label field={field} />
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

function Label({ field }: { field: SchemaField }) {
  return (
    <>
      {field.label}
      {field.required ? (
        <span className="text-destructive" title="Required">
          *
        </span>
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
