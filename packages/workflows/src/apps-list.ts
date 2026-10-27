import { z } from "zod";
import { appClaim, appTier, type Claims, claims, TIERS } from "./claims.ts";
import { defineConnector, defineDriver } from "./op.ts";
import { errorMessage } from "./shared.ts";

// The apps a company could take: GitHub's repositories with the topic `sanoma-app`, read when
// asked and never stored, joined with Sanoma's claims (`claims.ts`). One built-in read operation,
// `sanoma.apps.list`, which the app's Apps page and a public site's pages both call (`isDirect`
// admits it), under the policy as the person asking.

/** The topic a source repository carries so the listing finds it. */
export const APP_TOPIC = "sanoma-app";
/** GitHub's REST API, searched without a token (so rate-limited: ten searches a minute per address). */
export const GITHUB_API = "https://api.github.com";
/** How long GitHub gets to answer, so a slow or absent network only empties the list. */
const TIMEOUT_MS = 5_000;

/** One repository of GitHub's search answer: what the list shows of it. */
const Found = z.object({
  full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  html_url: z.url({ protocol: /^https$/, hostname: /^github\.com$/ }),
  description: z.string().nullish(),
  license: z.object({ spdx_id: z.string().nullish() }).nullish(),
});
const Search = z.object({ items: z.array(z.unknown()) });

/** An app's source on GitHub, with what Sanoma claims about it. */
export const AvailableApp = z.object({
  /** `<owner>/<repo>`, as GitHub names it. */
  repo: z.string(),
  /** Its page on GitHub, `https://github.com/<owner>/<repo>`: what `app.ts`'s `source` names once taken. */
  url: z.string(),
  description: z.string().optional(),
  /** Its licence's SPDX id, when GitHub recognizes one. */
  license: z.string().optional(),
  /** Its claim's tier, else official for `Sanoma-AI`'s, else community (`appTier`). */
  tier: z.enum(TIERS),
  reviewed: z.boolean(),
  /** Its commits Sanoma blocks. */
  blocked: z.array(z.string()).optional(),
  /** The solutions it is in, each with its demo's URL once that runs: where "Try it" goes. */
  solutions: z.array(z.object({ id: z.string(), title: z.string(), demo: z.string().optional() })),
});
export type AvailableApp = z.infer<typeof AvailableApp>;

/** The apps found, Sanoma's first; `error` says why there are none when GitHub could not be searched. */
export const AvailableApps = z.object({ apps: z.array(AvailableApp), error: z.string().optional() });
export type AvailableApps = z.infer<typeof AvailableApps>;

/** The built-in `sanoma.apps.list` (`APPS_LIST`), which `resolveConfig` registers in every config with its driver. */
export const appsListOps = defineConnector("sanoma", {
  apps: {
    list: {
      effect: "read",
      idempotent: true,
      description: `List the apps on GitHub (the topic ${APP_TOPIC}), with Sanoma's claims about each`,
      input: z.object({}),
      output: AvailableApps,
    },
  },
});

/** The driver of `sanoma.apps.list`: GitHub's search, now. */
export const appsListDriver = defineDriver(appsListOps, { apps: { list: () => availableApps() } });

/** An app found, with what `from` claims about it. */
function listed(found: z.infer<typeof Found>, from: Claims): AvailableApp {
  const repo = found.full_name;
  const claim = appClaim(repo, from);
  const solutions = (claim?.solutions ?? []).flatMap((id) => {
    const solution = from.solutions[id];
    return solution ? [{ id, title: solution.title, ...(solution.demo.url && { demo: solution.demo.url }) }] : [];
  });
  return {
    repo,
    url: found.html_url,
    ...(found.description && { description: found.description }),
    ...(found.license?.spdx_id && found.license.spdx_id !== "NOASSERTION" && { license: found.license.spdx_id }),
    tier: appTier(repo, from),
    reviewed: claim?.reviewed ?? false,
    ...(claim?.blocked?.length && { blocked: claim.blocked }),
    solutions,
  };
}

/** 1 for an official app, which the list shows first. */
const official = (app: AvailableApp) => Number(app.tier === "official");

/**
 * The repositories GitHub finds with the topic `sanoma-app`, the first hundred, each with what
 * `from` claims about it (the claims by default), official first, then by name. A repository
 * GitHub describes otherwise than expected is left out. When GitHub cannot be searched the list
 * is empty, and says why.
 */
export async function availableApps(from: Claims = claims): Promise<AvailableApps> {
  const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(`topic:${APP_TOPIC}`)}&per_page=100`;
  let items: unknown[];
  try {
    const res = await fetch(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "sanoma", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status} to ${new URL(url).pathname}`);
    items = Search.parse(await res.json()).items;
  } catch (err) {
    return { apps: [], error: `Could not search GitHub: ${errorMessage(err)}` };
  }
  return {
    apps: items
      .flatMap((item) => {
        const found = Found.safeParse(item);
        return found.success ? [listed(found.data, from)] : [];
      })
      .toSorted((a, b) => official(b) - official(a) || a.repo.localeCompare(b.repo, "en")),
  };
}
