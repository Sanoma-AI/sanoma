import type { ConfigDescription, WorkflowEntry } from "@sanoma/workflows";
import { type FormEvent, useMemo, useState } from "react";
import type { InputIssue, StartRunRequest, StartRunResponse } from "../../src/api.ts";
import { Notice } from "../components.tsx";
import { api, ApiError, errorText, runHref, usePoll } from "../lib.ts";
import { buildInput, type Field, fieldsOf, initialValue, type Value } from "../schema.ts";

export function StartPage({ workflow: wanted }: { workflow?: string }) {
  const { data: config, error } = usePoll<ConfigDescription>("/api/config");

  if (!config)
    return error ? <Notice tone="bad">Could not load the config: {error}</Notice> : <Notice>Loading…</Notice>;
  if (config.workflows.length === 0) return <Notice>This config has no workflows.</Notice>;
  const name = wanted ?? config.workflows[0]?.name;
  const workflow = config.workflows.find((w) => w.name === name);

  return (
    <section>
      <header className="page-head">
        <h1>Start a run</h1>
      </header>
      <label className="field">
        <span className="label">Workflow</span>
        <select
          value={workflow ? workflow.name : ""}
          onChange={(e) => (location.hash = `#/start?workflow=${encodeURIComponent(e.target.value)}`)}
        >
          {!workflow && <option value="">Choose a workflow</option>}
          {config.workflows.map((w) => (
            <option key={w.name} value={w.name}>
              {w.title ? `${w.title} (${w.name})` : w.name}
            </option>
          ))}
        </select>
      </label>
      {!workflow && name && <Notice tone="bad">No workflow named “{name}”.</Notice>}
      {workflow && <StartForm key={workflow.name} workflow={workflow} />}
    </section>
  );
}

function StartForm({ workflow }: { workflow: WorkflowEntry }) {
  const schema = JSON.stringify(workflow.input);
  // Re-read only when the schema itself changes, not on every poll.
  const fields = useMemo(() => fieldsOf(JSON.parse(schema) as Record<string, unknown>), [schema]);
  const [values, setValues] = useState<Record<string, Value>>(() =>
    Object.fromEntries((fields ?? []).map((f) => [f.name, initialValue(f)])),
  );
  const [whole, setWhole] = useState("{}");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    let input: unknown;
    if (fields) {
      const built = buildInput(fields, values);
      if (Object.keys(built.errors).length) {
        setFieldErrors(Object.fromEntries(Object.entries(built.errors).map(([k, v]) => [k, [v]])));
        setFormErrors([]);
        return;
      }
      input = built.input;
    } else {
      try {
        input = JSON.parse(whole);
      } catch {
        setFormErrors(["The input is not valid JSON"]);
        return;
      }
    }
    setBusy(true);
    setFieldErrors({});
    setFormErrors([]);
    try {
      const body: StartRunRequest = { workflow: workflow.name, input };
      const { runId } = await api<StartRunResponse>("/api/runs", { method: "POST", body });
      location.hash = runHref(runId);
    } catch (err) {
      if (err instanceof ApiError && err.body.issues) showIssues(err.body.issues);
      else setFormErrors([errorText(err)]);
    } finally {
      setBusy(false);
    }
  }

  function showIssues(issues: InputIssue[]) {
    const byField: Record<string, string[]> = {};
    const rest: string[] = [];
    for (const issue of issues) {
      const [head, ...tail] = issue.path;
      const field = fields?.find((f) => f.name === head);
      const message = tail.length ? `${tail.join(".")}: ${issue.message}` : issue.message;
      if (field) (byField[field.name] ??= []).push(message);
      else rest.push(issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message);
    }
    setFieldErrors(byField);
    setFormErrors(rest.length ? rest : ["The input does not match the workflow's schema"]);
  }

  return (
    <form className="start-form" onSubmit={(e) => void submit(e)} noValidate>
      {fields ? (
        fields.map((field) => (
          <FieldInput
            key={field.name}
            field={field}
            value={values[field.name]}
            errors={fieldErrors[field.name]}
            onChange={(v) => setValues((old) => ({ ...old, [field.name]: v }))}
          />
        ))
      ) : (
        <label className="field">
          <span className="label">Input (JSON)</span>
          <textarea className="mono" rows={8} value={whole} onChange={(e) => setWhole(e.target.value)} />
        </label>
      )}
      {formErrors.map((message) => (
        <p key={message} className="field-error">
          {message}
        </p>
      ))}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? "Starting…" : `Start ${workflow.name}`}
      </button>
    </form>
  );
}

function FieldInput({
  field,
  value,
  errors,
  onChange,
}: {
  field: Field;
  value: Value;
  errors?: string[];
  onChange: (value: Value) => void;
}) {
  const text = typeof value === "string" ? value : "";
  const id = `field-${field.name}`;
  let control;
  switch (field.kind) {
    case "string":
      control = <input id={id} type="text" value={text} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "datetime":
      control = <input id={id} type="datetime-local" value={text} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "number":
    case "integer":
      control = (
        <input
          id={id}
          type="number"
          step={field.kind === "integer" ? 1 : "any"}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    case "boolean":
      control = <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
      break;
    case "enum":
      control = (
        <select id={id} value={text} onChange={(e) => onChange(e.target.value)}>
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
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
  }
  return (
    <div className={`field${field.kind === "boolean" ? " inline" : ""}`}>
      <label className="label" htmlFor={id}>
        {field.label}
        {field.required ? (
          <span className="required" title="Required">
            {" "}
            *
          </span>
        ) : (
          <span className="muted"> (optional)</span>
        )}
      </label>
      {control}
      {field.description && <p className="hint">{field.description}</p>}
      {field.kind === "json" && <p className="hint">This field is entered as JSON.</p>}
      {errors?.map((message) => (
        <p key={message} className="field-error">
          {message}
        </p>
      ))}
    </div>
  );
}
