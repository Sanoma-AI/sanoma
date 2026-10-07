import type { WorkflowEntry } from "@sanoma/workflows";
import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useRef } from "react";
import { errorBodyOf, unwrap } from "../api.ts";
import { startRunFn } from "../functions.ts";
import {
  buildInput,
  type Field,
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
  const schema = JSON.stringify(workflow.input);
  // Re-read only when the schema itself changes, not on every render.
  const { fields, whole } = useMemo(() => {
    const read = fieldsOf(JSON.parse(schema) as Record<string, unknown>);
    const all: Field[] = read ?? [{ key: WHOLE, label: "Input (JSON)", kind: "json", required: true, default: {} }];
    return { fields: all, whole: !read };
  }, [schema]);
  const form = useStartForm(workflow.name, fields, whole);

  return (
    <form
      className="start-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      {fields.map((field) => (
        <FieldView key={field.key} form={form} field={field} name={field.key} />
      ))}
      <form.Subscribe selector={(s) => [s.errorMap.onSubmit, s.isSubmitting] as const}>
        {([error, submitting]) => (
          <>
            {typeof error === "string" && error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="primary" disabled={submitting}>
              {submitting ? "Starting…" : `Start ${workflow.name}`}
            </button>
          </>
        )}
      </form.Subscribe>
    </form>
  );
}

type FormValues = Record<string, any>;

function useStartForm(workflow: string, fields: Field[], whole: boolean) {
  const start = useServerFn(startRunFn);
  const navigate = useNavigate();
  const started = useRef<string | undefined>(undefined);
  return useForm({
    defaultValues: initialValues(fields) as FormValues,
    validators: {
      // Starting the run is the validation: the server checks the input against the workflow's
      // zod schema and answers with its issues, which land on the fields they name.
      onSubmitAsync: async ({ value }) => {
        const built = buildInput(fields, value);
        if (Object.keys(built.errors).length) return { fields: built.errors };
        try {
          const input = whole ? built.input[WHOLE] : built.input;
          started.current = unwrap(await start({ data: { workflow, input } })).runId;
          return undefined;
        } catch (err) {
          const body = errorBodyOf(err);
          if (!body?.issues?.length) return { form: body?.error ?? (err as Error).message };
          const byField: Record<string, string> = {};
          const rest: string[] = [];
          for (const issue of body.issues) {
            const target = issueTarget(fields, whole ? [WHOLE, ...issue.path] : issue.path, issue.message);
            if (target) byField[target.name] ??= target.message;
            else rest.push(issue.path.length ? `${pathName(issue.path)}: ${issue.message}` : issue.message);
          }
          return { form: rest.join("; ") || "The input does not match the workflow's schema", fields: byField };
        }
      },
    },
    onSubmit: async () => {
      if (started.current) await navigate({ to: "/runs/$id", params: { id: started.current } });
    },
  });
}

type StartFormApi = ReturnType<typeof useStartForm>;

/** One field, by its kind: a control, a group of controls, or a list with Add and Remove. */
function FieldView({ form, field, name }: { form: StartFormApi; field: Field; name: string }) {
  if (field.kind === "object") {
    return (
      <fieldset className="group">
        <legend>
          <Label field={field} />
        </legend>
        {field.description && <p className="hint">{field.description}</p>}
        {field.fields.map((sub) => (
          <FieldView key={sub.key} form={form} field={sub} name={`${name}.${sub.key}`} />
        ))}
      </fieldset>
    );
  }
  if (field.kind === "array") {
    const item = field.item;
    return (
      <form.Field name={name} mode="array">
        {(f) => (
          <fieldset className="group">
            <legend>
              <Label field={field} />
            </legend>
            {field.description && <p className="hint">{field.description}</p>}
            {(f.state.value as unknown[]).map((_, i) => (
              <div className="array-item" key={i}>
                <FieldView form={form} field={{ ...item, label: `${field.label} ${i + 1}` }} name={`${name}[${i}]`} />
                <button type="button" onClick={() => f.removeValue(i)} aria-label={`Remove ${field.label} ${i + 1}`}>
                  Remove
                </button>
              </div>
            ))}
            <button type="button" onClick={() => f.pushValue(initialValue(item, item.default))}>
              Add {item.kind === "object" ? "an item" : "a value"}
            </button>
            <Errors errors={f.state.meta.errors} />
          </fieldset>
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
        const onText = (e: { target: { value: string } }) => f.handleChange(e.target.value);
        let control;
        switch (field.kind) {
          case "string":
            control = <input id={id} type="text" value={text} onChange={onText} onBlur={f.handleBlur} />;
            break;
          case "datetime":
            control = <input id={id} type="datetime-local" value={text} onChange={onText} onBlur={f.handleBlur} />;
            break;
          case "number":
          case "integer":
            control = (
              <input
                id={id}
                type="number"
                step={field.kind === "integer" ? 1 : "any"}
                value={text}
                onChange={onText}
                onBlur={f.handleBlur}
              />
            );
            break;
          case "boolean":
            control = (
              <input
                id={id}
                type="checkbox"
                checked={value === true}
                onChange={(e) => f.handleChange(e.target.checked)}
              />
            );
            break;
          case "enum":
            control = (
              <select id={id} value={text} onChange={onText} onBlur={f.handleBlur}>
                <option value="">{field.required ? "Choose…" : "(leave out)"}</option>
                {(field.options ?? []).map((option, i) => (
                  <option key={String(option)} value={String(i)}>
                    {String(option)}
                  </option>
                ))}
              </select>
            );
            break;
          case "json":
            control = (
              <textarea
                id={id}
                className="mono"
                rows={4}
                placeholder="JSON"
                value={text}
                onChange={onText}
                onBlur={f.handleBlur}
              />
            );
            break;
        }
        return (
          <div className={`field${field.kind === "boolean" ? " inline" : ""}`}>
            <label className="label" htmlFor={id}>
              <Label field={field} />
            </label>
            {control}
            {field.description && <p className="hint">{field.description}</p>}
            {field.kind === "json" && <p className="hint">Entered as JSON.</p>}
            <Errors errors={f.state.meta.errors} />
          </div>
        );
      }}
    </form.Field>
  );
}

function Label({ field }: { field: Field }) {
  return (
    <>
      {field.label}
      {field.required ? (
        <span className="required" title="Required">
          {" "}
          *
        </span>
      ) : (
        <span className="muted"> (optional)</span>
      )}
    </>
  );
}

function Errors({ errors }: { errors: unknown[] }) {
  const messages = [...new Set(errors.filter(Boolean).map(String))];
  return messages.map((message) => (
    <p key={message} className="field-error" role="alert">
      {message}
    </p>
  ));
}
