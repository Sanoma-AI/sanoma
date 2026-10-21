// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { errorMessage } from "@sanoma-ai/workflows";
import { z } from "zod";
import { type AvailableConnector, type AvailableConnectors, tierOf } from "../api.ts";
import type { AppContext } from "../context.ts";

/** npm's registry: the search, and each package's latest version. */
export const NPM_REGISTRY = "https://registry.npmjs.org";
/** The keyword a connector package carries so the app finds it on npm. */
const KEYWORD = "sanoma-connector";
/** How long npm gets to answer each request, so a slow or absent network only empties the list. */
const TIMEOUT_MS = 5_000;

const Search = z.object({ objects: z.array(z.object({ package: z.object({ name: z.string() }) })) });

/** A package's latest version, as npm serves its package.json: what the list shows of it. */
const Latest = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string().optional().catch(undefined),
  homepage: z.string().optional().catch(undefined),
  sanoma: z.object({
    title: z.string().min(1),
    logo: z.string().optional().catch(undefined),
    logoDark: z.string().optional().catch(undefined),
  }),
});

/** A logo's path in the package: relative, inside it, an SVG. Any other path shows no logo. */
const LOGO_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w./-]+\.svg$/;

async function npmJson(path: string): Promise<unknown> {
  const res = await fetch(`${NPM_REGISTRY}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`npm answered ${res.status} to ${path.split("?")[0]}`);
  return res.json();
}

/** One package's latest version as the list shows it; undefined when it cannot be read or has no `sanoma` field. */
async function listed(name: string): Promise<AvailableConnector | undefined> {
  const latest = Latest.safeParse(await npmJson(`/${name.replace("/", "%2F")}/latest`).catch(() => undefined));
  if (!latest.success) return undefined;
  const { version, description, homepage, sanoma } = latest.data;
  // The logos are only ever an <img>'s src, from jsDelivr's copy of the published files.
  const logo = (path: string | undefined) =>
    path && LOGO_PATH.test(path) ? `https://cdn.jsdelivr.net/npm/${name}@${version}/${path}` : undefined;
  const src = logo(sanoma.logo);
  const dark = src && logo(sanoma.logoDark);
  return {
    package: name,
    title: sanoma.title,
    ...(description && { description }),
    version,
    tier: tierOf(name),
    ...(src && { logo: { src, ...(dark && { dark }) } }),
    ...(homepage && URL.parse(homepage)?.protocol === "https:" && { homepage }),
  };
}

/**
 * The connector packages on npm that the config does not install: found by their keyword, each
 * described by the `sanoma` field of its latest version, official ones first. Read on every call, never stored. When
 * npm cannot be searched the list is empty, and says why.
 */
export async function availableConnectors(app: AppContext): Promise<AvailableConnectors> {
  let names: string[];
  try {
    const found = Search.parse(await npmJson(`/-/v1/search?text=keywords:${KEYWORD}&size=250`));
    names = found.objects.map((o) => o.package.name);
  } catch (err) {
    return { connectors: [], error: `Could not search npm: ${errorMessage(err)}` };
  }
  const installed = new Set(Object.values(app.description.vendors).map((v) => v.package));
  const connectors = await Promise.all(names.filter((name) => !installed.has(name)).map(listed));
  return {
    connectors: connectors
      .filter((c) => c !== undefined)
      .toSorted(
        (a, b) => Number(b.tier === "official") - Number(a.tier === "official") || a.title.localeCompare(b.title),
      ),
  };
}
