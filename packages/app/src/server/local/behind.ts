// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { errorMessage } from "@sanoma-ai/workflows";
import type { AppContext } from "../../context.ts";

/**
 * How many commits the app `folder`'s source has that the live checkout lacks, fetched now
 * (`Source.behind`), or why that cannot be told: offline, no shared history, or an instance whose
 * repository cannot fetch. Only an app the description lists, taken from a source.
 */
export async function appBehind(
  { local, snapshot }: Pick<AppContext, "local" | "snapshot">,
  folder: string,
): Promise<{ behind: number } | { error: string }> {
  if (!snapshot.description.apps.some((app) => app.name === folder && app.source !== undefined)) {
    return { error: `No app apps/${folder}/ taken from a source` };
  }
  const source = local?.source;
  if (!source?.behind) return { error: "This instance's repository cannot fetch an app's source" };
  try {
    return { behind: await source.behind(folder) };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}
