import { useQuery } from "@tanstack/react-query";
import { Badge } from "#/components/ui/badge.tsx";
import type { Tone } from "#/lib/tone.ts";
import { cn } from "#/lib/utils.ts";
import type { CompanyState } from "../../api.ts";
import { companyStateQuery } from "../../queries.ts";
import { Tip, toneBadge, useClock } from "../kit.tsx";

const DAY_MS = 86_400_000;

/**
 * What the badge says of a free trial that ends at `endsAt` (ms), at `now`, and its tone: the days
 * left, counted in whole 24 hours so no time zone decides them, its last day, or that it ended.
 */
function trialBadge(endsAt: number, now: number): { label: string; tone: Tone } {
  const daysLeft = Math.ceil((endsAt - now) / DAY_MS);
  if (daysLeft <= 0) return { label: "Free trial ended", tone: "waiting" };
  if (daysLeft === 1) return { label: "Free trial · last day", tone: "waiting" };
  return { label: `Free trial · ${daysLeft} days left`, tone: "idle" };
}

const selectTrial = (company: CompanyState) => company.trialEndsAt;

/**
 * A Sanoma Cloud company's free trial, under the company's state in the bar (`StateBadge`'s look):
 * the days left, its last day, or that it ended, its tip the day and time it ends. It only
 * informs. Read from the company's state (`trialEndsAt`), which asks the Cloud nothing; counted in
 * the browser by the page's clock, so the server and the hydrating browser both render nothing.
 * Nothing for a company not on Sanoma Cloud, or a date that is none.
 */
export function TrialBadge() {
  const { data: trialEndsAt } = useQuery({ ...companyStateQuery(), select: selectTrial });
  const now = useClock();
  const endsAt = trialEndsAt ? Date.parse(trialEndsAt) : Number.NaN;
  if (now === undefined || Number.isNaN(endsAt)) return null;
  const { label, tone } = trialBadge(endsAt, now);
  const at = new Date(endsAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <Tip tip={`Your free trial ${endsAt > now ? "ends" : "ended"} on ${at}`}>
      <Badge
        tabIndex={0}
        className={cn(toneBadge({ tone }), "h-auto max-w-full rounded-md text-center text-bar whitespace-normal")}
      >
        {label}
      </Badge>
    </Tip>
  );
}
