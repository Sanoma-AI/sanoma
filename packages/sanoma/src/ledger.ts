import { resolveConfig, type SanomaConfig } from "@sanoma/workflows";

/**
 * A run's ledger records from the config's store, as JSON lines: one `JSON.stringify(record)`
 * per line, in `seq` order, the shape `jsonlLedger` keeps its files in. Empty for a run with no
 * records.
 */
export async function exportLedger(config: SanomaConfig, runId: string): Promise<string> {
  const records = await resolveConfig(config).ledger.read(runId);
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}
