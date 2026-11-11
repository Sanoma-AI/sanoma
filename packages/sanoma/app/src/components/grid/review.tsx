import type { CollectionEntry } from "sanoma/workflows/describe";
import type { TableChange, TableChangePlan, WontConvert } from "sanoma/workflows/description";
import type { ChangeReshaped } from "sanoma/workflows/shared";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardContent, CardHeader } from "#/components/ui/card.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "#/components/ui/collapsible.tsx";
import type { Tone } from "#/lib/tone.ts";
import { cn, plural } from "#/lib/utils.ts";
import type { ChangeDetail } from "../../api.ts";
import type { Verbs } from "../approval.tsx";
import { CardHeading, ToneBadge } from "../kit.tsx";
import { allRecords, DECIDED, diffLines, DOES, landed, renamed, typeWords } from "./plan.ts";

// A table change's review on its change's page (`routes/changes/$id.tsx`), from the plan the
// change carries (`ChangeState.plan`): once it merged, what became of the records
// (`ChangeState.merged.reshaped`); a card per change in its kind's words and tone (Safe, Clears or
// Keeps the values that won't convert, with a sample of them and the choice made where the change
// was proposed, Keeps the data), Try it first, The details (the data file's lines), and Couldn't
// apply this change over a run that failed before merging. Its decision is the change's own, in
// the table change's words (`TABLE_VERBS`). It reads nothing of the app itself (the page gives it
// the collection as main declares it), so a test renders it on its own.

/** A table change's Publish and Reject, as its review calls them. */
export const TABLE_VERBS: Verbs = { approve: "Approve and apply", reject: "Send back" };

/** A change card: its title, what kind of change it is (`tone`, `said`), and what it does to the records. */
function ChangeCard({
  title,
  detail,
  tone,
  said,
  children,
}: {
  title: string;
  detail?: string;
  tone: Tone;
  said: string;
  children: ReactNode;
}) {
  return (
    <Card
      size="sm"
      aria-label={title}
      role="region"
      className={cn(tone === "waiting" && "ring-tone-waiting-foreground/40")}
    >
      <CardHeader className="flex flex-wrap items-center gap-x-2.5">
        <CardHeading>{title}</CardHeading>
        {detail && <span className="text-sm text-muted-foreground">{detail}</span>}
        <span className="ml-auto">
          <ToneBadge tone={tone}>{said}</ToneBadge>
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">{children}</CardContent>
    </Card>
  );
}

/** The values a retype or a conversion cannot convert: a sample by key, and how many more. */
export function WontConvertSample({
  keyField,
  field,
  wontConvert: { count, sample },
}: {
  keyField: string;
  field: string;
  wontConvert: WontConvert;
}) {
  return (
    <div className="overflow-auto rounded-lg border">
      <table aria-label="Records that can't convert" className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="px-3 py-1.5 font-medium">
              {keyField}
            </th>
            <th scope="col" className="px-3 py-1.5 font-medium">
              {field} now
            </th>
          </tr>
        </thead>
        <tbody>
          {sample.map(({ key, value }) => (
            <tr key={key} className="border-b last:border-0">
              <td className="px-3 py-1.5 font-medium">{key}</td>
              <td className="px-3 py-1.5">{typeof value === "string" ? value : JSON.stringify(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {count > sample.length && (
        <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
          and {plural(count - sample.length, "record")} more
        </p>
      )}
    </div>
  );
}

/** One change of the plan as its card: what it does, in its kind's words and tone. */
function Planned({ change, plan, keyField }: { change: TableChange; plan: TableChangePlan; keyField: string }) {
  const all = allRecords(plan);
  switch (change.kind) {
    case "add": {
      const needs = change.required && change.empty > 0;
      return (
        <ChangeCard
          title={`Add ${change.field}`}
          detail={typeWords(change.type)}
          tone={needs ? "waiting" : "ok"}
          said={needs ? "Needs values" : "Safe"}
        >
          <p>
            {all} show it empty.
            {needs && " It is required: each needs a value before it saves again."}
          </p>
        </ChangeCard>
      );
    }
    case "rename":
      return (
        <ChangeCard title={`Rename ${change.from} to ${change.to}`} tone="ok" said="Safe">
          <p>{renamed(plan)}</p>
        </ChangeCard>
      );
    case "retype":
    case "convert": {
      const to = change.kind === "retype" ? change.to : change.type;
      const title =
        change.kind === "retype"
          ? `Change ${change.field} from ${typeWords(change.from)} to ${typeWords(to)}`
          : `Make ${change.key} of ${change.field} a column, ${typeWords(to)}`;
      const wont = change.wontConvert.count;
      if (wont === 0) {
        return (
          <ChangeCard title={title} tone="ok" said="Safe">
            <p>Every value converts.</p>
          </ChangeCard>
        );
      }
      // Chosen where the change was proposed; none (a plan drafted without one) keeps them.
      const decision = change.decision ?? "keep";
      return (
        <ChangeCard
          title={title}
          tone={decision === "clear" ? "waiting" : "idle"}
          said={decision === "clear" ? `Clears ${plural(wont, "value")}` : `Keeps ${wont} for fixing`}
        >
          <p>
            {plural(plan.rows - wont, "record")} convert. {wont} can't, because what's in them isn't {typeWords(to)}.
          </p>
          <WontConvertSample
            keyField={keyField}
            field={change.kind === "retype" ? change.field : change.key}
            wontConvert={change.wontConvert}
          />
          <p>
            <span className="font-medium">Chosen: {DECIDED[decision](wont).toLowerCase()}.</span> {DOES[decision]}
          </p>
          <p className="text-muted-foreground">To choose the other way, send the change back.</p>
        </ChangeCard>
      );
    }
    case "require":
      return (
        <ChangeCard
          title={`Make ${change.field} required`}
          tone={change.empty ? "waiting" : "ok"}
          said={change.empty ? "Needs values" : "Safe"}
        >
          <p>
            {change.empty
              ? `${plural(change.empty, "record")} have it empty: each needs a value before it saves again.`
              : "Every record has it."}
          </p>
        </ChangeCard>
      );
    case "hide":
      return (
        <ChangeCard title={`Remove ${change.field}`} tone="ok" said="Keeps the data">
          <p>
            It leaves the grid and the forms.{" "}
            {change.filled === 0
              ? "No record has a value in it."
              : `The values in ${plural(change.filled, "record")} are kept.`}
          </p>
        </ChangeCard>
      );
    case "link":
      return (
        <ChangeCard
          title={`Link ${change.field} to ${change.to}`}
          tone={change.unmatched ? "waiting" : "ok"}
          said={change.unmatched ? "Needs a decision" : "Safe"}
        >
          <p>
            {change.unmatched
              ? `${plural(change.unmatched, "record")} to match against ${change.to}'s records.`
              : `${all} match.`}
          </p>
        </ChangeCard>
      );
  }
}

/**
 * What became of the records once the change merged (`reshaped`): the counts in words, or, when
 * bringing them along failed, that the change is published and the records are as they were,
 * with the run to see why.
 */
function Reshaped({ runId, plan, reshaped }: { runId: string; plan: TableChangePlan; reshaped: ChangeReshaped }) {
  if ("error" in reshaped) {
    return (
      <Card size="sm" role="status" aria-label="The records" className="ring-tone-bad-foreground/40">
        <CardHeader className="flex flex-wrap items-center gap-x-2.5">
          <CardHeading>The records weren't updated</CardHeading>
          <ToneBadge tone="bad">Published without them</ToneBadge>
        </CardHeader>
        <CardContent className="text-sm">
          The change is published, but its records weren't brought along: {reshaped.error}. They hold what they held
          before.{" "}
          <Link to="/runs/$id" params={{ id: runId }} className="underline underline-offset-4">
            See the run
          </Link>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card size="sm" role="status" aria-label="The records">
      <CardHeader className="flex flex-wrap items-center gap-x-2.5">
        <CardHeading>The records</CardHeading>
        <ToneBadge tone="ok">Updated</ToneBadge>
      </CardHeader>
      <CardContent className="text-sm">{landed(plan, reshaped)}</CardContent>
    </Card>
  );
}

/**
 * A table change's review: once it merged, what became of the records; how many changes over how
 * many records, a card per change, Try it first, The details (`collection` as main declares it,
 * the data file's lines; none once main no longer declares it), and, over a run that failed
 * before merging, Couldn't apply this change.
 */
export function TableChangeReview({
  change,
  plan,
  collection,
}: {
  change: Pick<ChangeDetail, "runId" | "status" | "state">;
  plan: TableChangePlan;
  collection: CollectionEntry | undefined;
}) {
  const [details, setDetails] = useState(false);
  const keyField = collection?.key ?? "key";
  const many = plan.changes.length > 1;
  const reshaped = change.state.merged?.reshaped;
  return (
    <section aria-label="The table change" className="flex flex-col gap-3">
      {reshaped && <Reshaped runId={change.runId} plan={plan} reshaped={reshaped} />}
      {change.status === "failed" && !change.state.merged && (
        <Card size="sm" role="status" aria-label="Couldn't apply this change" className="ring-tone-bad-foreground/40">
          <CardHeader className="flex flex-wrap items-center gap-x-2.5">
            <CardHeading>Couldn't apply this change</CardHeading>
            <ToneBadge tone="waiting">Nothing changed</ToneBadge>
          </CardHeader>
          <CardContent className="text-sm">
            Your records and columns are exactly as they were.{" "}
            <Link to="/runs/$id" params={{ id: change.runId }} className="underline underline-offset-4">
              See what went wrong
            </Link>
          </CardContent>
        </Card>
      )}
      <p className="text-sm text-muted-foreground">
        {plural(plan.changes.length, "change")} to {plan.collection} · {plural(plan.rows, "record")}
        {many && ". They apply together: either every one lands, or none does."}
      </p>
      {plan.changes.map((planned, i) => (
        <Planned key={i} change={planned} plan={plan} keyField={keyField} />
      ))}
      <Card size="sm" role="region" aria-label="Try it first">
        <CardHeader>
          <CardHeading>Try it first</CardHeading>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-2.5 text-sm">
          <p>Open a copy of {plan.collection} with this change applied. Your real records aren't touched.</p>
          <Button variant="outline" disabled title="Copies arrive with previews">
            Try on a copy
          </Button>
        </CardContent>
      </Card>
      <Collapsible
        open={details}
        onOpenChange={setDetails}
        render={<Card size="sm" role="region" aria-label="The details" />}
      >
        <CardHeader className="flex flex-wrap items-center gap-x-2.5">
          <CardHeading>The details</CardHeading>
          <span className="text-sm text-muted-foreground">Only if you want them</span>
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="ml-auto" />}>
            {details ? "Hide" : "Show"}
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent render={<CardContent />}>
          {collection && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  The company's file · <code>{collection.declared?.file ?? "resources/data.ts"}</code>
                </span>
                <pre className="overflow-auto rounded-lg border bg-muted/40 px-3 py-2 text-xs leading-relaxed">
                  {diffLines(collection.fields, plan.changes).map((line, i) => (
                    <span
                      key={i}
                      className={cn("block", line.sign === "+" ? "bg-tone-ok/15" : "bg-tone-bad/15")}
                    >{`${line.sign}   ${line.text}`}</span>
                  ))}
                </pre>
              </div>
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
