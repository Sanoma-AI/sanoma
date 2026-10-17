import { useSuspenseQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import type { ApplyPlan, PlanAnswer, PlanStep } from "@sanoma-ai/workflows/describe";
import { exportName, plannedRows, rebindWords, STEP_GROUPS } from "../lib/apply-plan.ts";
import { configQuery } from "../queries.ts";
import { Disclosure, plural, Problems, ShortId as Id, SubsectionTitle, VendorLogo } from "./common.tsx";
import { FieldDiff } from "./field-diff.tsx";

/** Each resource type's title, lower case, by `<vendor>.<type>`: the noun a sentence names it by. */
const nounsOf = (config: { resourceTypes: { id: string; title: string }[] }) =>
  new Map(config.resourceTypes.map((t) => [t.id, t.title.toLowerCase()]));

/**
 * What apply would change, before it changes anything: what is wrong in the data files, each
 * change to the lockfile apply did not make (a rebind, in plain words), then the steps by action:
 * creates with their planned fields, updates and replaces with the fields that differ, binds,
 * gone objects and orphaned bindings with the question each asks, and the unchanged, folded.
 */
export function ApplyPlanView({ plan }: { plan: ApplyPlan }) {
  const { data: nouns } = useSuspenseQuery({ ...configQuery(), select: nounsOf });
  const groups = Map.groupBy(plan.steps, (step) => step.action);
  const unchanged = groups.get("none") ?? [];
  return (
    <div className="flex flex-col gap-(--gap-section)" data-slot="apply-plan">
      {plan.problems.length > 0 && <Problems problems={plan.problems} />}
      {plan.rebinds.length > 0 && (
        <Group title="Rebinds: changes to the lockfile apply did not make">
          <ul className="flex flex-col gap-1 text-sm">
            {plan.rebinds.map((r) => (
              <li key={r.key} title={r.key}>
                {rebindWords(r, nouns.get(r.type) ?? r.type)}
              </li>
            ))}
          </ul>
        </Group>
      )}
      {STEP_GROUPS.filter(([action]) => action !== "none").map(([action, title]) => {
        const steps = groups.get(action);
        return (
          steps && (
            <Group key={action} title={`${title} (${steps.length})`}>
              {steps.map((step) => (
                <Step key={step.id} step={step} noun={nouns.get(`${step.vendor}.${step.type}`) ?? step.type} />
              ))}
            </Group>
          )
        );
      })}
      {unchanged.length > 0 && (
        <Disclosure label={`${plural(unchanged.length, "resource")} unchanged`}>
          <ul className="flex flex-col gap-1 text-sm">
            {unchanged.map((step) => (
              <li key={step.id}>
                <StepName step={step} />
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {plan.steps.length === 0 && plan.rebinds.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing to change.</p>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <SubsectionTitle>{title}</SubsectionTitle>
      {children}
    </section>
  );
}

/** A step's resource: its vendor's logo, its name, and its type and id. */
function StepName({ step }: { step: PlanStep }) {
  const key = step.action === "orphan" ? step.key : step.id;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <VendorLogo vendor={step.vendor} alt="" className="size-4" />
      <span className="font-medium">{exportName(key)}</span>
      <code className="text-xs text-muted-foreground">{`${step.vendor}.${step.type}`}</code>
      <code className="text-xs text-muted-foreground">{key}</code>
    </span>
  );
}

const ANSWERED: Record<PlanAnswer, string> = {
  recreate: "recreate it",
  forget: "forget the binding",
  delete: "delete it at the vendor",
};

/** What apply would do with one resource, and for a gone object or an orphaned binding, the question it asks. */
function Step({ step, noun }: { step: PlanStep; noun: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border p-3 text-sm">
      <StepName step={step} />
      <StepBody step={step} noun={noun} />
    </div>
  );
}

function StepBody({ step, noun }: { step: PlanStep; noun: string }) {
  switch (step.action) {
    case "create":
      return <Planned step={step} />;
    case "update":
    case "replace":
      return (
        <>
          <p className="text-muted-foreground">
            {step.action === "replace" ? "Deletes and recreates" : "Changes"} the {noun} bound as{" "}
            <Id id={step.binding} />
            {step.action === "replace" && step.replace.length > 0 && (
              <>
                , since <code>{step.replace.join(", ")}</code> cannot change in place
              </>
            )}
            .
          </p>
          <FieldDiff id={step.id} fields={step.fields} />
        </>
      );
    case "bind":
      return (
        <p className="text-muted-foreground">
          Binds it to the {noun} <Id id={step.binding} />,{" "}
          {step.source === "found" ? "which its identity found at the vendor" : "as given"}.
        </p>
      );
    case "gone":
      return (
        <p className="text-muted-foreground">
          The {noun} bound as <Id id={step.binding} /> is gone at the vendor.{" "}
          {step.answer
            ? `Answered: ${ANSWERED[step.answer]}.`
            : "Apply asks whether to recreate it (a new, empty one: what it held is lost) or forget the binding."}
        </p>
      );
    case "orphan":
      return (
        <p className="text-muted-foreground">
          The lockfile binds it to the {noun} <Id id={step.binding} />, but no data file declares it.{" "}
          {step.answer
            ? `Answered: ${ANSWERED[step.answer]}.`
            : "Apply asks whether to forget the binding or delete the object at the vendor."}
        </p>
      );
    case "none":
      return null;
  }
}

/** A create's fields: what it sends, and what the vendor fills in, known after apply. */
function Planned({ step }: { step: Extract<PlanStep, { action: "create" }> }) {
  return (
    <Table className="text-xs">
      <TableHeader>
        <TableRow>
          <TableHead>Field</TableHead>
          <TableHead>Planned</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {plannedRows(step).map((row) => (
          <TableRow key={row.path}>
            <TableCell>
              <code>{row.path}</code>
            </TableCell>
            <TableCell className="whitespace-pre-wrap">
              {row.known ? (
                <code>{JSON.stringify(row.value)}</code>
              ) : (
                <span className="text-muted-foreground italic">known after apply</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
