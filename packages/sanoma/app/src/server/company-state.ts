// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { APPLY_WORKFLOW, type SanomaClient } from "sanoma/workflows";
import { DRIFT_WORKFLOW, GO_LIVE_CLOUD_WORKFLOW, GO_LIVE_HOST_WORKFLOW } from "sanoma/workflows/shared";
import type { CompanyState } from "../api.ts";
import type { AppContext } from "../context.ts";
import { companyStateOf, declaredHostOf, hostAt, isLive } from "../lib/company-state.ts";
import { answers, appliedHost, goLiveRunOf, KEYS } from "./go-live.ts";

// The facts a company's state is read from (`companyStateOf`): the lockfile's bindings and
// `infra.ts`'s host as the snapshot read them, where this instance is, going live's latest run,
// for a company live on Sanoma Cloud when its free trial ends, and, only when Hosting asks, where
// the host answers and whether it does.

/** How long an answer from the host's `/healthz` is taken as it is. */
const PROBE_MS = 10_000;
/**
 * The host's latest answers, by URL, in this process, each kept from when it was asked (so two
 * requests at once share one): a page's polls never ask more than every `PROBE_MS`.
 */
const probes = new Map<string, { at: number; healthy: Promise<boolean> }>();

/**
 * Going live's latest run, of `go-live-host` (the company's own accounts) and `go-live-cloud`
 * (Sanoma Cloud): its apply (`<run>:apply`) once it started it, else that run itself, while it
 * pushes or once it failed before its apply. A `go-live-cloud` whose apply ended but that failed
 * after it (an apply that left a step undone) is the run itself, which says why.
 */
async function goLiveRun(client: SanomaClient) {
  const latest = await Promise.all(
    [GO_LIVE_HOST_WORKFLOW, GO_LIVE_CLOUD_WORKFLOW].map((workflow) => client.runs({ workflow, limit: 1 })),
  );
  const [run] = latest.flat().toSorted((a, b) => b.createdAt - a.createdAt);
  if (!run) return null;
  const apply = await client.run(`${run.runId}:apply`);
  return goLiveRunOf(client, apply && (apply.status !== "finished" || run.status !== "failed") ? apply : run);
}

/** The host's row in the latest drift check that finished, when it read where the host answers. */
async function checkedHost(client: SanomaClient) {
  const [run] = await client.runs({ workflow: DRIFT_WORKFLOW, status: "finished", limit: 1 });
  return run && (await client.driftReport(run.runId)).resources.find((r) => r.id === KEYS.host)?.host;
}

/**
 * When the company's free trial at Sanoma Cloud ends, as its host was last read: by the latest
 * apply that made or changed the host, unless the latest drift check that finished is newer (the
 * Cloud's answer, passed on in the host's outputs, `HostOutputs.trialEndsAt`); none while the Cloud
 * does not run the company. Read from the reports in the company's own database: nothing asks the
 * Cloud, which the trial is read from only as apply and drift read the host anyway.
 */
async function trialEnd(client: SanomaClient): Promise<string | undefined> {
  const [[drift], applies] = await Promise.all([
    client.runs({ workflow: DRIFT_WORKFLOW, status: "finished", limit: 1 }),
    client.runs({ workflow: APPLY_WORKFLOW, status: "finished", limit: 10 }),
  ]);
  for (const run of applies) {
    if (drift && drift.createdAt > run.createdAt) break;
    const { results } = await client.applyReport(run.runId);
    const host = results.find((r) => r.id === KEYS.host && r.host)?.host;
    if (host) return host.trialEndsAt;
  }
  return drift && (await client.driftReport(drift.runId)).resources.find((r) => r.id === KEYS.host)?.host?.trialEndsAt;
}

/**
 * Whether the host answers at `host`: on a hosted instance yes, since it is this one; unknown
 * while it is not bound, as the address may be no host of the company's yet; else its `/healthz`
 * asked once its last answer is `PROBE_MS` old, and the last answer otherwise.
 */
async function healthy(app: AppContext, host: { url: string; wakeUrl?: string }) {
  if (app.place === "live") return true;
  if (!app.snapshot.bound.includes(KEYS.host)) return undefined;
  const last = probes.get(host.url);
  if (last && Date.now() - last.at < PROBE_MS) return last.healthy;
  const answer = answers(host);
  probes.set(host.url, { at: Date.now(), healthy: answer });
  return answer;
}

/**
 * The company's state. Where the host answers (the latest apply that made it, else the latest
 * drift check, else its declared hostname) and whether `/healthz` does are read only with `force`
 * (Hosting, as it opens and while going live): the badge and Home never wake a host that stops
 * when idle. For a company live on a Sanoma Cloud host, when its free trial ends (`trialEnd`),
 * from its own database; any other company reads nothing for it.
 */
export async function companyState(app: AppContext, { force = false } = {}): Promise<CompanyState> {
  const { snapshot, resolved, client, place } = app;
  const declaredHost = declaredHostOf(snapshot.description.resources, resolved.types);
  const onCloud = declaredHost?.place === "cloud" && isLive(snapshot.bound, place);
  const [run, trialEndsAt] = await Promise.all([goLiveRun(client), onCloud ? trialEnd(client) : undefined]);
  const facts = {
    trialEndsAt,
    bound: snapshot.bound,
    place,
    declared: declaredHost?.place ?? null,
    repository: snapshot.repository?.remote !== undefined || snapshot.bound.includes(KEYS.repo),
    run,
  } as const;
  if (!force) return companyStateOf(facts);
  const hostname = declaredHost?.resource.desired.hostname;
  const [applied, checked] = await Promise.all([appliedHost(client), checkedHost(client)]);
  const at = hostAt({ applied, checked, hostname: typeof hostname === "string" ? hostname : undefined });
  return companyStateOf({ ...facts, host: at && { url: at.url, healthy: await healthy(app, at) } });
}
