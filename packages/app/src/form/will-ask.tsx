import type { WorkflowEntry } from "@sanoma-ai/workflows/describe";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { CardDescription } from "#/components/ui/card.tsx";
import { useActor } from "../actor.ts";
import { previewRequests, willAsk } from "../lib/preview.ts";
import { configQuery, opsById, previewQuery } from "../queries.ts";

/**
 * What the policy will do on a run of `workflow` started by you, ahead of the start (`willAsk`):
 * one line, or nothing while it allows everything, the page knows no name, or the preview fails.
 * A repo with no policies is not asked.
 */
export function WillAsk({ workflow }: { workflow: WorkflowEntry }) {
  const { actor } = useActor();
  const { data: policy } = useSuspenseQuery({ ...configQuery(), select: (config) => config.policy });
  const { data: ops } = useSuspenseQuery({ ...configQuery(), select: opsById });
  const requests = useMemo(() => previewRequests(workflow, ops), [workflow, ops]);
  const { data: answers } = useQuery({
    ...previewQuery(actor ?? "", workflow.name, requests),
    enabled: policy.defined && !!actor,
  });
  const line = policy.defined && answers ? willAsk(requests, answers) : undefined;
  return line ? <CardDescription>{line}</CardDescription> : null;
}
