// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { errorMessage, isSvgElement, SanomaPackageField } from "@sanoma-ai/workflows";
import { connectorTier } from "@sanoma-ai/workflows/shared";
import { svgDataUrl } from "@sanoma-ai/workflows/describe";
import { z } from "zod";
import type { AvailableConnector, AvailableConnectors } from "../api.ts";

/** npm's registry: the search, and each package's latest version. */
export const NPM_REGISTRY = "https://registry.npmjs.org";
/** jsDelivr's copy of each published package's files: where its logos are read from. */
export const JSDELIVR = "https://cdn.jsdelivr.net/npm";
/** The keyword a connector package carries so the app finds it on npm. */
const KEYWORD = "sanoma-connector";
/** How long npm and jsDelivr get to answer each request, so a slow or absent network only empties the list. */
const TIMEOUT_MS = 5_000;
/** The most of a logo file read: a mark, not a picture. */
const MAX_LOGO = 16 * 1024;

const Search = z.object({ objects: z.array(z.object({ package: z.object({ name: z.string() }) })) });

/** A package's latest version, as npm serves its package.json: what the list shows of it. */
const Latest = z.object({
  version: z.string(),
  description: z.string().optional().catch(undefined),
  homepage: z.string().optional().catch(undefined),
  sanoma: SanomaPackageField,
});

/** `url`'s answer, or an error saying who answered what. */
async function fetched(url: string): Promise<Response> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status} to ${new URL(url).pathname}`);
  return res;
}

/** A logo file of a published package as a `data:` URL, as installed vendors' are; undefined when it is no logo. */
async function logoOf(name: string, version: string, path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  const svg = await fetched(`${JSDELIVR}/${name}@${version}/${path}`)
    // A file that says it is larger is not read.
    .then((res) => (Number(res.headers.get("content-length")) > MAX_LOGO ? undefined : res.text()))
    .catch(() => undefined);
  return svg && svg.length <= MAX_LOGO && isSvgElement(svg) ? svgDataUrl(svg) : undefined;
}

/** One package's latest version as the list shows it; undefined when it cannot be read or has no valid `sanoma` field. */
async function listed(name: string): Promise<AvailableConnector | undefined> {
  const json = await fetched(`${NPM_REGISTRY}/${name.replace("/", "%2F")}/latest`)
    .then((res) => res.json())
    .catch(() => undefined);
  const latest = Latest.safeParse(json);
  if (!latest.success) return undefined;
  const { version, description, homepage, sanoma } = latest.data;
  const [src, dark] = await Promise.all([logoOf(name, version, sanoma.logo), logoOf(name, version, sanoma.logoDark)]);
  return {
    package: name,
    title: sanoma.title,
    ...(description && { description }),
    version,
    ...(src && { logo: { src, ...(dark && { dark }) } }),
    ...(homepage && URL.parse(homepage)?.protocol === "https:" && { homepage }),
  };
}

/** 1 for Sanoma's own package, which the list shows first. */
const official = (c: AvailableConnector) => Number(connectorTier(c.package) === "official");

/**
 * The connector packages on npm: found by their keyword, each described by the `sanoma` field of
 * its latest version, its logos read from jsDelivr and checked as installed ones are, Sanoma's
 * first. The page leaves out those the config installs. Read on every call, never stored. When
 * npm cannot be searched the list is empty, and says why.
 */
export async function availableConnectors(): Promise<AvailableConnectors> {
  let names: string[];
  try {
    const res = await fetched(`${NPM_REGISTRY}/-/v1/search?text=keywords:${KEYWORD}&size=250`);
    names = Search.parse(await res.json()).objects.map((o) => o.package.name);
  } catch (err) {
    return { connectors: [], error: `Could not search npm: ${errorMessage(err)}` };
  }
  const connectors = await Promise.all(names.map(listed));
  return {
    connectors: connectors
      .filter((c) => c !== undefined)
      .toSorted((a, b) => official(b) - official(a) || a.title.localeCompare(b.title, "en")),
  };
}
