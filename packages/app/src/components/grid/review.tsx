import type { CollectionEntry } from "@sanoma-ai/workflows/describe";
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
import {
  allRecords,
  diffLines,
  FILE_ONLY,
  fileOnly,
  NO_SQL,
  type RetypeDecision,
  type TableChange,
  type TableChangePlan,
  typeWords,
} from "./plan.ts";

// A table change's review on its change's page (`routes/changes/$id.tsx`), from the plan the
// change carries (`ChangeState.plan`): a card per change in its kind's words and tone (Safe, Needs
// a decision with the rows that won't convert, Keeps the data), Try it first, The details (the
// data file's lines and what runs on the database), and Couldn't apply this change over a run
// that failed. Its decision is the change's own, in the table change's words (`TABLE_VERBS`). It
// reads nothing of the app itself (the page gives it the collection as main declares it), so a
// test renders it on its own.

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

/** The rows a retype or a conversion cannot convert, a sample by key, and the two choices for them. */
function WontConvert({
  keyField,
  field,
  change,
}: {
  keyField: string;
  field: string;
  change: Extract<TableChange, { kind: "retype" | "convert" }>;
}) {
  const [decision, setDecision] = useState<RetypeDecision | undefined>(
    change.kind === "retype" ? change.decision : undefined,
  );
  const { count, sample } = change.wontConvert;
  const choices: [RetypeDecision, string][] = [
    ["clear-unconvertible", `Convert the rest and leave these ${count} empty`],
    ["keep-text", `Keep ${field} as text while someone fixes them in the grid`],
  ];
  return (
    <>
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
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-medium">What should happen to these {count}?</legend>
        {choices.map(([value, label]) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="radio"
              name={`unconverted-${field}`}
              value={value}
              checked={decision === value}
              onChange={() => setDecision(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-muted-foreground">
        Your choice goes with Approve and apply once the table change lands; until then the original text stays as it
        is.
      </p>
    </>
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
          <p>{all} keep their values under the new name.</p>
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
      return wont === 0 ? (
        <ChangeCard title={title} tone="ok" said="Safe">
          <p>Every value converts.</p>
        </ChangeCard>
      ) : (
        <ChangeCard title={title} tone="waiting" said="Needs a decision">
          <p>
            {plural(plan.rows - wont, "record")} convert. {wont} can't, because what's in them isn't {typeWords(to)}.
          </p>
          <WontConvert
            keyField={keyField}
            field={change.kind === "retype" ? change.field : change.key}
            change={change}
          />
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
    case "delete":
      return (
        <ChangeCard title={`Remove ${change.field}`} tone="ok" said="Keeps the data">
          <p>
            It leaves the grid and the forms.{" "}
            {change.filled === 0 ? "No record has a value in it." : `All ${change.filled} values are kept.`}
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
 * A table change's review: how many changes over how many records, a card per change, Try it
 * first, The details (`collection` as main declares it, the data file's lines; none once main no
 * longer declares it), and, over a run that failed before merging, Couldn't apply this change.
 * A plan with no SQL yet says so when it touches the records (`FILE_ONLY`): only the file changes.
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
  return (
    <section aria-label="The table change" className="flex flex-col gap-3">
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
      {fileOnly(plan) && (
        <p role="note" className="rounded-lg border px-3 py-2 text-sm text-muted-foreground">
          {FILE_ONLY}
        </p>
      )}
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
          <div className="flex flex-col gap-3">
            {collection && (
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
            )}
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">What runs on the database</span>
              {plan.sql.length ? (
                <pre className="overflow-auto rounded-lg border bg-muted/40 px-3 py-2 text-xs leading-relaxed">
                  {plan.sql.join("\n")}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">{NO_SQL}.</p>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
