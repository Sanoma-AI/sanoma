import type { OpEntry, WorkflowEntry } from "@sanoma/workflows";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { EffectBadge, Notice } from "../components/common.tsx";
import { type Field, fieldsOf } from "../form/schema.ts";
import { configQuery } from "../queries.ts";

export const Route = createFileRoute("/workflows")({
  loader: ({ context }) => context.queryClient.ensureQueryData(configQuery()),
  head: () => ({ meta: [{ title: "Workflows · Sanoma" }] }),
  component: WorkflowsPage,
});

function WorkflowsPage() {
  const { data: config, error } = useQuery(configQuery());

  if (!config) return error ? <Notice tone="bad">Could not load the config: {error.message}</Notice> : null;
  const ops = new Map(config.ops.map((op) => [op.id, op]));
  return (
    <section>
      <header className="page-head">
        <h1>Workflows</h1>
      </header>
      <dl className="facts">
        <dt>App</dt>
        <dd>{config.appName}</dd>
        <dt>Version</dt>
        <dd>
          <code>{config.version}</code>
        </dd>
        <dt>Policy</dt>
        <dd>
          {config.policy.defined ? (
            <>
              a policy checks every operation call
              {config.policy.version ? (
                <>
                  {" "}
                  (version <code>{config.policy.version}</code>)
                </>
              ) : (
                " (no version named)"
              )}
            </>
          ) : (
            "allowAll: every operation call is allowed"
          )}
        </dd>
      </dl>
      {config.workflows.length === 0 && <Notice>This config has no workflows.</Notice>}
      <div className="cards">
        {config.workflows.map((wf) => (
          <WorkflowCard key={wf.name} workflow={wf} ops={ops} />
        ))}
      </div>
    </section>
  );
}

function WorkflowCard({ workflow, ops }: { workflow: WorkflowEntry; ops: Map<string, OpEntry> }) {
  const fields = fieldsOf(workflow.input);
  return (
    <article className="card">
      <header className="row">
        <h2>{workflow.title ?? workflow.name}</h2>
        <code className="muted">{workflow.name}</code>
        <Link className="button push" to="/start" search={{ workflow: workflow.name }}>
          Start
        </Link>
      </header>
      <h3>Operations it may call</h3>
      {workflow.ops.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul className="ops">
          {workflow.ops.map((id) => {
            const op = ops.get(id);
            return (
              <li key={id}>
                <code>{id}</code> {op && <EffectBadge effect={op.effect} />}
                {op?.idempotent && (
                  <span className="muted" title="Safe to retry: the vendor dedupes repeated calls">
                    {" "}
                    idempotent
                  </span>
                )}
                {op?.description && <p className="hint">{op.description}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <h3>Built-ins</h3>
      <p>{workflow.builtins.length ? workflow.builtins.join(", ") : <span className="muted">None.</span>}</p>
      <h3>Input</h3>
      {fields ? (
        fields.length === 0 ? (
          <p className="muted">No fields.</p>
        ) : (
          <ul className="inputs">
            {fields.map((f) => (
              <InputField key={f.key} field={f} />
            ))}
          </ul>
        )
      ) : (
        <pre className="json">{JSON.stringify(workflow.input, null, 2)}</pre>
      )}
    </article>
  );
}

const kindName = (f: Field): string =>
  f.kind === "array" ? `list of ${kindName(f.item)}` : f.kind === "json" ? "JSON" : f.kind;

function InputField({ field }: { field: Field }) {
  return (
    <li>
      <code>{field.key}</code> <span className="muted">{kindName(field)}</span>
      {field.required ? <span className="required"> required</span> : null}
      {field.default !== undefined && <span className="muted"> · default {JSON.stringify(field.default)}</span>}
      {field.description && <p className="hint">{field.description}</p>}
      {field.kind === "object" && (
        <ul className="inputs">
          {field.fields.map((f) => (
            <InputField key={f.key} field={f} />
          ))}
        </ul>
      )}
    </li>
  );
}
