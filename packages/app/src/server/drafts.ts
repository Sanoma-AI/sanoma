import type { CheckResult } from "@sanoma-ai/workflows";
import type { AppContext } from "../context.ts";

/**
 * `sanoma check` on the draft `id`, as the instance's repository runs it (`Source.check`), for a
 * draft's card and the agent that drafts: its problems and warnings, without the grid, which a
 * change's review reads.
 */
export async function checks({ source }: Pick<AppContext, "source">, id: string): Promise<CheckResult> {
  if (!source?.check) {
    return { ok: false, problems: ["sanoma check: this instance's repository cannot check a draft"], warnings: [] };
  }
  const { grid: _, ...checked } = await source.check(id);
  return checked;
}
