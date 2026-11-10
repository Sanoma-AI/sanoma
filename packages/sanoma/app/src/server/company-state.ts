// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import type { SanomaClient } from "sanoma/workflows";
import { DRIFT_WORKFLOW, GO_LIVE_HOST_WORKFLOW, isEnded } from "sanoma/workflows/shared";
import type { CompanyState } from "../api.ts";
import type { AppContext } from "../context.ts";
import { companyStateOf, hostAt } from "../lib/company-state.ts";
import { answers, appliedHost, goLiveRunOf, KEYS } from "./go-live.ts";

// The facts a company's state is read from (`companyStateOf`): the lockfile's bindings and
// `infra.ts`'s host as the snapshot read them, where this instance is, going live's latest run,
// and, only while going live and when Hosting asks, where the host answers and whether it does.

/** How long an answer from the host's `/healthz` is taken as it is. */
const PROBE_MS = 10_000;
/** The host's latest answers, by URL, in this process: so a page's polls never ask more than every `PROBE_MS`. */
const probes = new Map<string, { at: number; healthy: boolean }>();

/**
 * Going live's latest run: the latest `go-live-host`'s apply (`<run>:apply`) once it started it,
 * else that run itself, while it pushes or once it failed before its apply.
 */
async function goLiveRun(client: SanomaClient) {
  const [run] = await client.runs({ workflow: GO_LIVE_HOST_WORKFLOW, limit: 1 });
  if (!run) return null;
  return goLiveRunOf(client, (await client.run(`${run.runId}:apply`)) ?? run);
}

/** The host's row in the latest drift check that finished, when it read where the host answers. */
async function checkedHost(client: SanomaClient) {
  const [run] = await client.runs({ workflow: DRIFT_WORKFLOW, status: "finished", limit: 1 });
  return run && (await client.driftReport(run.runId)).resources.find((r) => r.id === KEYS.host)?.host;
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
  const answer = { at: Date.now(), healthy: await answers(host) };
  probes.set(host.url, answer);
  return answer.healthy;
}

/**
 * The company's state. Where the host answers (the latest apply that made it, else the latest
 * drift check, else its declared hostname) and whether `/healthz` does are read only while going
 * live and with `force` (Hosting, as it opens): the badge and Home never wake a host that stops
 * when idle.
 */
export async function companyState(app: AppContext, { force = false } = {}): Promise<CompanyState> {
  const { snapshot, resolved, client, place } = app;
  const declaredHost = snapshot.description.resources.find((r) => r.id === KEYS.host);
  const type = declaredHost && resolved.types.get(`${declaredHost.vendor}.${declaredHost.type}`);
  const run = await goLiveRun(client);
  const facts = {
    bound: snapshot.bound,
    place,
    declared: type?.host ? (type.host.bindsBootstrap ? "cloud" : "own") : null,
    repository: snapshot.repository?.remote !== undefined || snapshot.bound.includes(KEYS.repo),
    run,
  } as const;
  if (!force && !(run && !isEnded(run.status))) return companyStateOf(facts);
  const hostname = declaredHost?.desired.hostname;
  const [applied, checked] = await Promise.all([appliedHost(client), checkedHost(client)]);
  const at = hostAt({ applied, checked, hostname: typeof hostname === "string" ? hostname : undefined });
  return companyStateOf({ ...facts, host: at && { url: at.url, healthy: await healthy(app, at) } });
}
