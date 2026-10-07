import type { ConfigDescription, OpEntry, WorkflowEntry } from "@sanoma/workflows";
import { EffectBadge, Notice } from "../components.tsx";
import { usePoll } from "../lib.ts";
import { fieldsOf } from "../schema.ts";

export function WorkflowsPage() {
  const { data: config, error } = usePoll<ConfigDescription>("/api/config");

  if (!config)
    return error ? <Notice tone="bad">Could not load the config: {error}</Notice> : <Notice>Loading…</Notice>;
  const ops = new Map(config.ops.map((op) => [op.id, op]));
  return (
    <section>
      <header className="page-head">
        <h1>Workflows</h1>
        <p className="muted">
          {config.appName} ·{" "}
          {config.policy.defined
            ? "a policy checks every operation call"
            : "no policy is configured, so every operation call is allowed"}
        </p>
      </header>
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
        <a className="button push" href={`#/start?workflow=${encodeURIComponent(workflow.name)}`}>
          Start
        </a>
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
              <li key={f.name}>
                <code>{f.name}</code> <span className="muted">{f.kind === "json" ? "JSON" : f.kind}</span>
                {f.required ? <span className="required"> required</span> : null}
                {f.default !== undefined && <span className="muted"> · default {JSON.stringify(f.default)}</span>}
                {f.description && <p className="hint">{f.description}</p>}
              </li>
            ))}
          </ul>
        )
      ) : (
        <pre className="json">{JSON.stringify(workflow.input, null, 2)}</pre>
      )}
    </article>
  );
}
