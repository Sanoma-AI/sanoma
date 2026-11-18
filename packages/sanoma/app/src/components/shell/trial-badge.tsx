import { useQuery } from "@tanstack/react-query";
import { ClientOnly } from "@tanstack/react-router";
import { Badge } from "#/components/ui/badge.tsx";
import type { Tone } from "#/lib/tone.ts";
import { cn } from "#/lib/utils.ts";
import type { CloudTrial, CompanyState } from "../../api.ts";
import { cloudTrialQuery, companyStateQuery } from "../../queries.ts";
import { Tip, toneBadge } from "../kit.tsx";

/** What the badge says of a free trial, and its tone: the days left, its last day, or that it ended. */
function trialBadge({ daysLeft }: Pick<CloudTrial, "daysLeft">): { label: string; tone: Tone } {
  if (daysLeft <= 0) return { label: "Free trial ended", tone: "waiting" };
  if (daysLeft === 1) return { label: "Free trial · last day", tone: "waiting" };
  return { label: `Free trial · ${daysLeft} days left`, tone: "idle" };
}

const selectOnCloud = (company: CompanyState) => company.onCloud;

/**
 * A Sanoma Cloud company's free trial, under the company's state in the bar (`StateBadge`'s look):
 * the days left, its last day, or that it ended, its tip the day and time it ends. It only informs.
 * Asked only once the company's state says it runs on Sanoma Cloud (`cloudTrialQuery`), so any
 * other company asks nothing; nothing while the trial cannot be read. After hydration only: the
 * time is the browser's.
 */
export function TrialBadge() {
  const { data: onCloud } = useQuery({ ...companyStateQuery(), select: selectOnCloud });
  const { data: trial } = useQuery({ ...cloudTrialQuery(), enabled: onCloud === true });
  if (!trial) return null;
  const { label, tone } = trialBadge(trial);
  const at = new Date(trial.endsAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <ClientOnly>
      <Tip tip={`Your free trial ${trial.daysLeft > 0 ? "ends" : "ended"} on ${at}`}>
        <Badge
          tabIndex={0}
          className={cn(toneBadge({ tone }), "h-auto max-w-full rounded-md text-center text-bar whitespace-normal")}
        >
          {label}
        </Badge>
      </Tip>
    </ClientOnly>
  );
}
