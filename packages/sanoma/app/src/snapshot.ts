import type { HostRootFacts, RootSnapshot } from "@sanoma-ai/workflows";
import type { ConfigDescription, SiteEntry } from "@sanoma-ai/workflows/describe";
import { siteDir } from "@sanoma-ai/workflows/shared";
import type { ScenariosResponse } from "./api.ts";
import type { Published } from "./content-files.ts";

// What the app knows of the company, made from its files where they are (`appSnapshot` in
// `snapshot-build.ts`, Node only) and handed to the app as data, so its handler reads no file:
// the Node adapter makes it at start and again once a file it was made from changed, and the
// Worker's bundle carries the one it was built with.

/**
 * The company as the app reads it: the root's people, policies, app name and versions
 * (`RootSnapshot`, which the Worker registers for the runtime, `useRootSnapshot`), and what the
 * app's pages read of the files.
 */
export interface AppSnapshot extends RootSnapshot {
  /** `describeConfig(config)` without the sources of the workflows read from their files (`withoutSources`): what `getConfig` answers. */
  description: ConfigDescription;
  /**
   * The text of each file the description names (`getSource`), by the path it names it by: a
   * workflow's file (its outline's `file`, with `\n` line endings) and a company file (a
   * resource's, a collection's, a site's or an app's, or a problem's, relative to the root).
   */
  sources: Record<string, string>;
  /** The scenarios in the feature files, as the page lists them (`getScenarios`); none, with why as the one error, when they cannot be read. */
  scenarios: ScenariosResponse;
  /** Each content kind under `content/`, with the front matter keys its files hold (`contentFields`). */
  content: { kind: string; fields: string[] }[];
  /** The published content each public site's sitemap lists (`publishedOf`): drafts left out. */
  published: Published;
  /** The repository the app was given, when it was: where a change is reviewed. */
  repository?: {
    /** Its remote's URL, with no credentials; none without a remote. Never sent to a page. */
    remote?: string;
    /** Each of the config's workflows by name, its file's path from the repository's root, with `/`. */
    workflows: Record<string, string>;
  };
  /** `resources/sanoma/infra.ts` as written, or null before going live writes it. */
  infra: string | null;
  /** The declarations the lockfile binds, by key (`<file>#<export>`). */
  bound: string[];
  /**
   * What a declared host that derives is filled from at the root (`hostRootFacts`), and the
   * default branch of each repository such a host may run from, by clone URL; none when no
   * declared host derives.
   */
  host?: HostRootFacts & { branches: Record<string, string> };
}

/** Whether the site's `site.ts` has a problem: then the site is served on no host, as its login could be one not read. */
export const siteFileBroken = (site: SiteEntry) =>
  site.problems.some((p) => p.file === `${siteDir(site.name)}/site.ts`);

/** What the Worker serves of the public sites: each whose `site.ts` reads, with its login when it has one. */
export const servedOnWorker = (site: SiteEntry) => site.public && !siteFileBroken(site);

/**
 * The description as the page gets it: without the source of a workflow read from its file, which
 * is a whole file that `getSource` serves, one at a time. A workflow read from `run`'s own text keeps it.
 */
export const withoutSources = (description: ConfigDescription): ConfigDescription => ({
  ...description,
  workflows: description.workflows.map((workflow) => {
    if (!("file" in workflow.outline)) return workflow;
    const { source: _, ...entry } = workflow;
    return entry;
  }),
});
